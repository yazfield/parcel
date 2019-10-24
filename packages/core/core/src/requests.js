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

import path from 'path';

import {md5FromObject, isGlob} from '@parcel/utils';

import ResolverRunner from './ResolverRunner';
import {EntryResolver} from './EntryResolver';
import type {EntryResult} from './EntryResolver'; // ? Is this right
import TargetResolver from './TargetResolver';
import type {TargetResolveResult} from './TargetResolver';

// TODO: shouldn't need this once we get rid of loadConfigHandle
export function generateRequestId(type: string, request: JSONObject | string) {
  return md5FromObject({type, request});
}

class Request<TRequestDesc: JSONObject | string, TResult> {
  id: string;
  type: string;
  request: TRequestDesc;
  runFn: TRequestDesc => Promise<TResult>;
  storeResult: boolean;
  isSecondaryRequest: boolean;
  result: ?TResult;
  promise: ?Promise<TResult>;
  options: ParcelOptions;

  constructor({
    type,
    request,
    runFn,
    storeResult,
    isSecondaryRequest,
    options
  }: {|
    type: string,
    request: TRequestDesc,
    runFn: TRequestDesc => Promise<TResult>,
    storeResult?: boolean,
    isSecondaryRequest?: boolean,
    options: ParcelOptions
  |}) {
    this.id = generateRequestId(type, request);
    this.type = type;
    this.request = request;
    this.runFn = runFn;
    this.storeResult = storeResult || true;
    this.isSecondaryRequest = isSecondaryRequest || false;
    this.options = options;
  }

  async run(): Promise<TResult> {
    this.result = null;
    this.promise = this.runFn(this.request);
    let result = await this.promise;
    if (this.storeResult) {
      this.result = result;
    }
    this.promise = null;

    return result;
  }

  // vars need to be defined for flow
  addResultToGraph(
    requestNode: RequestNode, // eslint-disable-line no-unused-vars
    result: TResult, // eslint-disable-line no-unused-vars
    graph: RequestGraph // eslint-disable-line no-unused-vars
  ) {
    throw new Error('Request Subclass did not override `addResultToGraph`');
  }
}

export class EntryRequest extends Request<FilePath, EntryResult> {
  constructor({
    request,
    entryResolver,
    options
  }: {|
    request: FilePath,
    entryResolver: EntryResolver
  |}) {
    super({
      type: 'entry_request',
      request,
      runFn: () => entryResolver.resolveEntry(request),
      storeResult: false,
      options
    });
  }

  addResultToGraph(
    requestNode: EntryRequestNode,
    result: EntryResult,
    graph: RequestGraph
  ) {
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

export class TargetRequest extends Request<FilePath, TargetResolveResult> {
  constructor({
    request,
    targetResolver,
    options
  }: {|
    request: FilePath,
    targetResolver: TargetResolver
  |}) {
    super({
      type: 'target_request',
      request,
      runFn: () => targetResolver.resolve(path.dirname(request)),
      storeResult: false,
      options
    });
  }

  addResultToGraph(
    requestNode: TargetRequestNode,
    result: TargetResolveResult,
    graph: RequestGraph
  ) {
    // Connect files like package.json that affect the target
    // resolution so we invalidate when they change.
    for (let file of result.files) {
      graph.invalidateOnFileUpdate(requestNode, file.filePath);
    }
  }
}

export class AssetRequest extends Request<
  AssetRequestDesc,
  AssetRequestResult
> {
  constructor({
    request,
    runTransform,
    loadConfig,
    options
  }: {|
    request: AssetRequestDesc,
    // TODO: get shared flow type
    runTransform: ({|
      request: AssetRequestDesc,
      loadConfig: (ConfigRequest, NodeId) => Promise<Config>,
      parentNodeId: NodeId,
      options: ParcelOptions
      //workerApi: WorkerApi // ? Does this need to be here?
    |}) => Promise<AssetRequestResult>,
    loadConfig: any, //TODO
    options: ParcelOptions
  |}) {
    let type = 'asset_request';
    super({
      type,
      request,
      runFn: async () => {
        let start = Date.now();
        let {assets, configRequests} = await runTransform({
          request,
          loadConfig,
          parentNodeId: generateRequestId(type, request), // ? Will this be the right value
          options
        });

        let time = Date.now() - start;
        for (let asset of assets) {
          asset.stats.time = time;
        }
        return {assets, configRequests};
      },
      options
    });
  }

  addResultToGraph(requestNode, result, graph) {
    let {assets, configRequests} = result;

    graph.invalidateOnFileUpdate(
      requestNode,
      requestNode.value.request.filePath
    );

    let subrequestNodes = [];
    // Add config requests
    for (let {request, result} of configRequests) {
      let id = generateRequestId('config_request', request);
      graph.addSubrequest({
        id,
        type: 'config_request',
        request,
        result
      });
      let subrequestNode = graph.getNode(id);
      if (graph.invalidNodeIds.has(id)) {
        if (result.resolvedPath != null) {
          graph.invalidateOnFileUpdate(subrequestNode, result.resolvedPath);
        }

        for (let filePath of result.includedFiles) {
          graph.invalidateOnFileUpdate(subrequestNode, filePath);
        }

        if (result.watchGlob != null) {
          graph.invalidateOnCreate(subrequestNode, result.watchGlob);
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
        graph.addSubrequest({
          id,
          type: 'dep_version_request',
          request: depVersionRequst,
          result: version
        });
        let subrequestNode = graph.getNode(id);
        if (graph.invalidNodeIds.has(id)) {
          if (this.options.lockFile != null) {
            graph.invalidateOnFileUpdate(this.options.lockFile);
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

export class DepPathRequest extends Request<
  Dependency,
  AssetRequestDesc | null | void
> {
  constructor({
    request,
    resolverRunner,
    options
  }: {|
    request: Dependency,
    resolverRunner: ResolverRunner
  |}) {
    super({
      type: 'dep_path_request',
      request,
      runFn: () => resolverRunner.resolve(request),
      storeResult: false,
      options
    });
  }

  addResultToGraph(requestNode, result, graph) {
    // TODO: invalidate dep path requests that have failed and a file creation may fulfill the request
    if (result) {
      graph.invalidateOnFileDelete(requestNode, result.filePath);
    }
  }
}
