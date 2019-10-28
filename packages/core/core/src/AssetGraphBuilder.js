// @flow strict-local

import type {AbortSignal} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
import type WorkerFarm from '@parcel/workers';
import type {Event} from '@parcel/watcher';
import type {
  Asset,
  AssetGraphNode,
  AssetRequestDesc,
  ParcelOptions,
  Target
} from './types';
import type ParcelConfig from './ParcelConfig';

import EventEmitter from 'events';
import nullthrows from 'nullthrows';
import path from 'path';
import {md5FromObject, md5FromString} from '@parcel/utils';
import AssetGraph from './AssetGraph';
import RequestTracker, {RequestGraph} from './RequestTracker';
import {PARCEL_VERSION} from './constants';
import {
  generateRequestId,
  EntryRequestRunner,
  TargetRequestRunner,
  AssetRequestRunner,
  DepPathRequestRunner
} from './requests';

import dumpToGraphViz from './dumpGraphToGraphViz';

type Opts = {|
  options: ParcelOptions,
  config: ParcelConfig,
  name: string,
  entries?: Array<string>,
  assetRequests?: Array<AssetRequestDesc>,
  workerFarm: WorkerFarm
|};

export default class AssetGraphBuilder extends EventEmitter {
  assetGraph: AssetGraph;
  requestGraph: RequestGraph;
  requestTracker: RequestTracker;

  changedAssets: Map<string, Asset> = new Map();
  options: ParcelOptions;
  config: ParcelConfig;
  workerFarm: WorkerFarm;
  cacheKey: string;

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
      onNodeRemoved: node => this.handleNodeRemovedFromAssetGraph(node)
    });

    let runnerMap = {
      entry_request: new EntryRequestRunner({options}),
      target_request: new TargetRequestRunner({options}),
      asset_request: new AssetRequestRunner({options, workerFarm}),
      dep_path_request: new DepPathRequestRunner({options, config})
      // config_request: new ConfigRequestRunner({options}),
      // dep_version_request: new DepVersionRequestRunner({options})
    };
    this.requestTracker = new RequestTracker({
      runnerMap,
      requestGraph: this.requestGraph
    });

    if (changes) {
      this.requestGraph.invalidateUnpredictableNodes();
      this.requestTracker.respondToFSEvents(changes);
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
    while (this.assetGraph.hasIncompleteNodes()) {
      let promises = [];
      for (let id of this.assetGraph.incompleteNodeIds) {
        let node = this.assetGraph.getNode(id);
        nullthrows(node);
        promises.push(this.processIncompleteAssetGraphNode(node, signal));
      }

      await Promise.all(promises);
    }

    dumpToGraphViz(this.assetGraph, 'AssetGraph');
    dumpToGraphViz(this.requestGraph, 'RequestGraph');

    let changedAssets = this.changedAssets;
    this.changedAssets = new Map();

    return {assetGraph: this.assetGraph, changedAssets: changedAssets};
  }

  validate(): Promise<void> {
    console.log('TODO: reimplement AssetGraphBuilder.validate()');
    // for (let asset of this.changedAssets) {
    //   this.runValidate({asset, config});
    // }
  }

  processIncompleteAssetGraphNode(node: AssetGraphNode, signal: AbortSignal) {
    switch (node.type) {
      case 'entry_specifier':
        return this.runEntryRequest(node.value, signal);
      case 'entry_file':
        return this.runTargetRequest(node.value, signal);
      case 'dependency':
        return this.runDepPathRequest(node.value, signal);
      case 'asset_group':
        return this.runAssetRequest(node.value, signal);
      default:
        throw new Error(
          `AssetGraphNode of type ${node.type} should not be marked incomplete`
        );
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
      this.requestTracker.removeRequest(type, request);
    }
  }

  async runEntryRequest(request, signal) {
    let result = await this.requestTracker.runRequest(
      'entry_request',
      request,
      {signal}
    );
    this.assetGraph.resolveEntry(request, result.entries);
  }

  async runTargetRequest(request, signal) {
    let result = await this.requestTracker.runRequest(
      'target_request',
      request,
      {signal}
    );
    this.assetGraph.resolveTargets(request, result.targets);
  }

  async runAssetRequest(request, signal) {
    let result = await this.requestTracker.runRequest(
      'asset_request',
      request,
      {signal}
    );
    this.assetGraph.resolveAssetGroup(request, result.assets);
    for (let asset of result.assets) {
      this.changedAssets.set(asset.id, asset); // ? Is this right?
    }
  }

  async runDepPathRequest(request, signal) {
    let result = await this.requestTracker.runRequest(
      'dep_path_request',
      request,
      {signal}
    );
    if (result != null) {
      this.assetGraph.resolveDependency(request, result);
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
