// @flow strict-local

import type {FilePath, JSONObject} from '@parcel/types';
import type {
  AssetRequestDesc,
  AssetRequestResult,
  Config,
  Dependency,
  EntryRequestNode,
  NodeId,
  ParcelOptions,
  RequestNode,
  TargetRequestNode
} from './types';
import type {RequestRunner} from './RequestTracker';
import type AssetGraph from './AssetGraph';
import type ParcelConfig from './ParcelConfig';
import type {TargetResolveResult} from './TargetResolver';
import type {EntryResult} from './EntryResolver'; // ? Is this right

import path from 'path';
import {isGlob} from '@parcel/utils';
import ResolverRunner from './ResolverRunner';
import {EntryResolver} from './EntryResolver';
import TargetResolver from './TargetResolver';
import {generateRequestId} from './RequestTracker';

export class EntryRequestRunner implements RequestRunner {
  entryResolver: EntryResolver;
  assetGraph: AssetGraph;

  constructor({
    options,
    assetGraph
  }: {|
    options: ParcelOptions,
    assetGraph: AssetGraph
  |}) {
    this.entryResolver = new EntryResolver(options);
    this.assetGraph = assetGraph;
  }

  run(request) {
    return this.entryResolver.resolveEntry(request);
  }

  onComplete(
    requestNode: EntryRequestNode,
    result: EntryResult,
    graph: RequestGraph
  ) {
    this.assetGraph.resolveEntry(requestNode.value.request, result.entries);

    // Connect files like package.json that affect the entry
    // resolution so we invalidate when they change.
    for (let file of result.files) {
      graph.invalidateOnFileUpdate(requestNode, file.filePath);
    }

    // If the entry specifier is a glob, add a glob node so
    // we invalidate when a new file matches.
    if (isGlob(requestNode.value.request)) {
      graph.invalidateOnFileCreate(requestNode, requestNode.value.request);
    }
  }
}

export class TargetRequestRunner implements RequestRunner {
  targetResolver: TargetResolver;
  assetGraph: AssetGraph;

  constructor({
    options,
    assetGraph
  }: {|
    options: ParcelOptions,
    assetGraph: AssetGraph
  |}) {
    this.targetResolver = new TargetResolver(options);
    this.assetGraph = assetGraph;
  }

  run(request) {
    return this.targetResolver.resolve(path.dirname(request));
  }

  onComplete(
    requestNode: TargetRequestNode,
    result: TargetResolveResult,
    graph: RequestGraph
  ) {
    this.assetGraph.resolveTargets(requestNode.value.request, result.targets);

    // Connect files like package.json that affect the target
    // resolution so we invalidate when they change.
    for (let file of result.files) {
      graph.invalidateOnFileUpdate(requestNode, file.filePath);
    }
  }
}

export class AssetRequestRunner implements RequestRunner {
  options: ParcelOptions;
  runTransform: TransformationOpts => Promise<AssetRequestResult>;
  assetGraph: AssetGraph;

  constructor({
    options,
    workerFarm,
    assetGraph
  }: {|
    options: ParcelOptions,
    workerFarm: WorkerFarm,
    assetGraph: AssetGraph
  |}) {
    this.options = options;
    this.runTransform = workerFarm.createHandle('runTransform');
    this.assetGraph = assetGraph;
  }

  async run(request) {
    let start = Date.now();
    let {assets, configRequests} = await this.runTransform({
      request,
      options: this.options
    });

    let time = Date.now() - start;
    for (let asset of assets) {
      asset.stats.time = time;
    }
    return {assets, configRequests};
  }

  onComplete(requestNode, result, graph) {
    this.assetGraph.resolveAssetGroup(requestNode.value.request, result.assets);

    let {assets, configRequests} = result;

    graph.invalidateOnFileUpdate(
      requestNode,
      requestNode.value.request.filePath
    );

    let subrequestNodes = [];
    // Add config requests
    for (let {request, result} of configRequests) {
      let id = generateRequestId('config_request', request);
      let shouldSetupInvalidations =
        graph.invalidNodeIds.has(id) || !graph.hasNode(id);
      let subrequestNode = graph.addRequest({
        id,
        type: 'config_request',
        request,
        result
      });

      if (shouldSetupInvalidations) {
        if (result.resolvedPath != null) {
          graph.invalidateOnFileUpdate(subrequestNode, result.resolvedPath);
        }

        for (let filePath of result.includedFiles) {
          graph.invalidateOnFileUpdate(subrequestNode, filePath);
        }

        if (result.watchGlob != null) {
          graph.invalidateOnFileCreate(subrequestNode, result.watchGlob);
        }
      }
      subrequestNodes.push(graph.getNode(id));

      // Add dep version requests
      for (let [moduleSpecifier, version] of result.devDeps) {
        let depVersionRequst = {
          moduleSpecifier,
          resolveFrom: result.resolvedPath // TODO: resolveFrom should be nearest package boundary
        };
        let id = generateRequestId('dep_version_request', depVersionRequst);
        let shouldSetupInvalidations =
          graph.invalidNodeIds.has(id) || !graph.hasNode(id);
        let subrequestNode = graph.addRequest({
          id,
          type: 'dep_version_request',
          request: depVersionRequst,
          result: version
        });
        if (shouldSetupInvalidations) {
          if (this.options.lockFile != null) {
            graph.invalidateOnFileUpdate(subrequestNode, this.options.lockFile);
          }
        }
        subrequestNodes.push(subrequestNode);
      }
    }

    graph.replaceSubrequests(requestNode, subrequestNodes);

    return assets;

    // TODO: add includedFiles even if it failed so we can try a rebuild if those files change
  }
}

export class DepPathRequestRunner implements RequestRunner {
  resolverRunner: ResolverRunner;
  assetGraph: AssetGraph;

  constructor({
    options,
    config,
    assetGraph
  }: {|
    options: ParcelOptions,
    config: ParcelConfig,
    assetGraph: AssetGraph
  |}) {
    this.resolverRunner = new ResolverRunner({
      options,
      config
    });
    this.assetGraph = assetGraph;
  }

  run(request) {
    return this.resolverRunner.resolve(request);
  }

  onComplete(requestNode, result, graph) {
    this.assetGraph.resolveDependency(requestNode.value.request, result);
    // TODO: invalidate dep path requests that have failed and a file creation may fulfill the request
    if (result) {
      graph.invalidateOnFileDelete(requestNode, result.filePath);
    }
  }
}
