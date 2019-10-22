// @flow strict-local

import type {AbortSignal} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
import type WorkerFarm from '@parcel/workers';
import type {Event} from '@parcel/watcher';
import type {
  Asset,
  AssetGraphNode,
  AssetRequestDesc,
  AssetRequestResult,
  Config,
  ConfigRequestDesc,
  ParcelOptions,
  Target,
  TransformationOpts
} from './types';

import EventEmitter from 'events';
import {md5FromObject, md5FromString} from '@parcel/utils';
import nullthrows from 'nullthrows';

import AssetGraph from './AssetGraph';
import type ParcelConfig from './ParcelConfig';
import RequestGraph from './RequestGraph';
import {PARCEL_VERSION} from './constants';
import {
  generateRequestId,
  EntryRequest,
  TargetRequest,
  AssetRequest,
  DepPathRequest
} from './requests';
import ResolverRunner from './ResolverRunner';
import {EntryResolver} from './EntryResolver';
import TargetResolver from './TargetResolver';
import ConfigLoader from './ConfigLoader';
import {addDevDependency} from './InternalConfig';

import dumpToGraphViz from './dumpGraphToGraphViz';
import path from 'path';

type Opts = {|
  options: ParcelOptions,
  config: ParcelConfig,
  name: string,
  entries?: Array<string>,
  targets?: Array<Target>, // ? Is this still used?
  assetRequests?: Array<AssetRequestDesc>,
  workerFarm: WorkerFarm
|};

type AssetGraphBuilderRequest =
  | EntryRequest
  | TargetRequest
  | AssetRequest
  | DepPathRequest;

export default class AssetGraphBuilder extends EventEmitter {
  assetGraph: AssetGraph;
  requestGraph: RequestGraph<AssetGraphBuilderRequest>;
  changedAssets: Map<string, Asset> = new Map();
  options: ParcelOptions;
  cacheKey: string;
  loadConfigHandle: () => Promise<Config>;
  entryResolver: EntryResolver;
  targetResolver: TargetResolver;
  resolverRunner: ResolverRunner;
  configLoader: ConfigLoader;
  runTransform: TransformationOpts => Promise<AssetRequestResult>;

  async init({
    config,
    options,
    entries,
    name,
    assetRequests,
    workerFarm
  }: Opts) {
    this.options = options;
    let {minify, hot, scopeHoist} = options;
    this.cacheKey = md5FromObject({
      parcelVersion: PARCEL_VERSION,
      name,
      options: {minify, hot, scopeHoist},
      entries
    });

    let changes = await this.readFromCache();
    if (!changes) {
      this.assetGraph = new AssetGraph();
      this.requestGraph = new RequestGraph();
    }

    this.assetGraph.initOptions({
      onNodeAdded: node => this.handleNodeAddedToAssetGraph(node),
      onNodeRemoved: node => this.handleNodeRemovedFromAssetGraph(node)
    });

    this.requestGraph.initOptions({
      config,
      options,
      onRequestComplete: this.handleCompletedRequest.bind(this),
      workerFarm
    });

    this.entryResolver = new EntryResolver(this.options);
    this.targetResolver = new TargetResolver(this.options);

    this.resolverRunner = new ResolverRunner({
      config,
      options
    });

    this.runTransform = workerFarm.createHandle('runTransform');
    //this.runValidate = workerFarm.createHandle('runValidate');
    // $FlowFixMe
    this.loadConfigHandle = workerFarm.createReverseHandle(
      this.loadConfig.bind(this)
    );
    this.configLoader = new ConfigLoader(options);

    if (changes) {
      this.requestGraph.invalidateUnpredictableNodes();
      this.respondToFSEvents(changes);
    } else {
      this.assetGraph.initialize({
        entries,
        assetGroups: assetRequests
      });
    }
  }

  async build(
    signal?: AbortSignal
  ): Promise<{|
    assetGraph: AssetGraph,
    changedAssets: Map<string, Asset>
  |}> {
    await this.requestGraph.completeRequests();

    dumpToGraphViz(this.assetGraph, 'AssetGraph');
    dumpToGraphViz(this.requestGraph, 'RequestGraph');

    let changedAssets = this.changedAssets;
    this.changedAssets = new Map();

    return {assetGraph: this.assetGraph, changedAssets: changedAssets};
  }

  validate(): Promise<void> {
    return this.requestGraph.completeValidations();
  }

  // NOTE: not adding config and dep version requests to graph in middle of refactor
  async loadConfig(configRequest: ConfigRequestDesc) {
    let config = await this.configLoader.load(configRequest);

    for (let [moduleSpecifier, version] of config.devDeps) {
      if (version == null) {
        let {pkg} = await this.options.packageManager.resolve(
          `${moduleSpecifier}/package.json`,
          `${config.resolvedPath}/index`
        );

        // TODO: Figure out how to handle when local plugin packages change, since version won't be enough
        version = nullthrows(pkg).version;
        addDevDependency(config, moduleSpecifier, version);
      }
    }

    return config;
  }

  handleNodeAddedToAssetGraph(node: AssetGraphNode) {
    let request;
    switch (node.type) {
      case 'entry_specifier': {
        request = new EntryRequest({
          request: node.value,
          entryResolver: this.entryResolver
        });
        break;
      }
      case 'entry_file':
        request = new TargetRequest({
          request: node.value,
          targetResolver: this.targetResolver
        });
        break;
      case 'dependency':
        request = new DepPathRequest({
          request: node.value,
          resolverRunner: this.resolverRunner
        });
        break;
      case 'asset_group':
        request = new AssetRequest({
          request: node.value,
          runTransform: this.runTransform,
          loadConfig: this.loadConfigHandle,
          options: this.options
        });
        break;
      case 'asset': {
        let asset = node.value;
        this.changedAssets.set(asset.id, asset); // ? Is this right?
        break;
      }
    }

    if (request) {
      this.requestGraph.addRequest(request);
    }
  }

  handleNodeRemovedFromAssetGraph(node: AssetGraphNode) {
    let removeId;
    switch (node.type) {
      case 'dependency':
        removeId = generateRequestId('dep_path_request', node.value);
        break;
      case 'asset_group':
        removeId = generateRequestId('asset_request', node.value);
        break;

      case 'entry_specifier':
        removeId = generateRequestId('entry_request', node.value);
        break;

      case 'entry_file':
        removeId = generateRequestId('target_request', node.value);
        break;
    }

    if (removeId != null) {
      this.requestGraph.removeById(removeId);
    }
  }

  handleCompletedRequest(request: AssetGraphBuilderRequest) {
    if (request instanceof EntryRequest) {
      this.assetGraph.resolveEntry(request.request, request.result.entries);
    } else if (request instanceof TargetRequest) {
      this.assetGraph.resolveTargets(request.request, request.result.targets);
    } else if (request instanceof AssetRequest) {
      let {assets} = request.result;
      this.assetGraph.resolveAssetGroup(request.request, assets);
      for (let asset of assets) {
        this.changedAssets.set(asset.id, asset); // ? Is this right?
      }
    } else if (request instanceof DepPathRequest) {
      if (request.result != null) {
        this.assetGraph.resolveDependency(request.request, request.result);
      }
    }
  }

  respondToFSEvents(events: Array<Event>) {
    return this.requestGraph.respondToFSEvents(events);
  }

  getWatcherOptions() {
    let vcsDirs = ['.git', '.hg'].map(dir =>
      path.join(this.options.projectRoot, dir)
    );
    let ignore = [this.options.cacheDir, ...vcsDirs];
    return {ignore};
  }

  getCacheKeys() {
    let assetGraphKey = md5FromString(`${this.cacheKey}:assetGraph`);
    let requestGraphKey = md5FromString(`${this.cacheKey}:requestGraph`);
    let snapshotKey = md5FromString(`${this.cacheKey}:snapshot`);
    return {assetGraphKey, requestGraphKey, snapshotKey};
  }

  async readFromCache(): Promise<?Array<Event>> {
    if (this.options.disableCache) {
      return null;
    }

    let {assetGraphKey, requestGraphKey, snapshotKey} = this.getCacheKeys();
    let assetGraph = await this.options.cache.get(assetGraphKey);
    let requestGraph = await this.options.cache.get(requestGraphKey);

    if (assetGraph && requestGraph) {
      this.assetGraph = assetGraph;
      this.requestGraph = requestGraph;

      let opts = this.getWatcherOptions();
      let snapshotPath = this.options.cache._getCachePath(snapshotKey, '.txt');
      return this.options.inputFS.getEventsSince(
        this.options.projectRoot,
        snapshotPath,
        opts
      );
    }

    return null;
  }

  async writeToCache() {
    if (this.options.disableCache) {
      return;
    }

    let {assetGraphKey, requestGraphKey, snapshotKey} = this.getCacheKeys();
    await this.options.cache.set(assetGraphKey, this.assetGraph);
    await this.options.cache.set(requestGraphKey, this.requestGraph);

    let opts = this.getWatcherOptions();
    let snapshotPath = this.options.cache._getCachePath(snapshotKey, '.txt');
    await this.options.inputFS.writeSnapshot(
      this.options.projectRoot,
      snapshotPath,
      opts
    );
  }
}
