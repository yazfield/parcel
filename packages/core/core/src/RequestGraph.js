// @flow strict-local

import type {AbortSignal} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
import type {FilePath, Glob} from '@parcel/types';
import type {Event} from '@parcel/watcher';
import type {ParcelOptions} from './types';

import invariant from 'assert';
import nullthrows from 'nullthrows';

import {PromiseQueue, isGlobMatch} from '@parcel/utils';
import WorkerFarm from '@parcel/workers';

import Graph, {type GraphOpts} from './Graph';
import type ParcelConfig from './ParcelConfig';

import type {NodeId, ValidationOpts} from './types';

import {assertSignalNotAborted} from './utils';

type RequestGraphOpts = {|
  ...GraphOpts<RequestGraphNode>,
  config: ParcelConfig,
  options: ParcelOptions,
  onRequestComplete: (any, any) => mixed, // TODO
  workerFarm: WorkerFarm
|};

type SerializedRequestGraph = {|
  ...GraphOpts<RequestGraphNode>,
  invalidNodeIds: Set<NodeId>,
  globNodeIds: Set<NodeId>,
  depVersionRequestNodeIds: Set<NodeId>
|};

type FileNode = {|id: string, +type: 'file', value: File|};
type GlobNode = {|id: string, +type: 'glob', value: Glob|};
type RequestGraphNode = RequestNode | FileNode | GlobNode;

type RequestGraphEdgeType =
  | 'invalidated_by_update'
  | 'invalidated_by_delete'
  | 'invalidated_by_create';

const nodeFromFilePath = (filePath: string) => ({
  id: filePath,
  type: 'file',
  value: {filePath}
});

const nodeFromGlob = (glob: Glob) => ({
  id: glob,
  type: 'glob',
  value: glob
});

const nodeFromRequest = (request: HasTypeAndId) => ({
  id: request.id,
  type: 'request',
  value: request
});

type HasTypeAndId = {
  type: string,
  id: string,
  ...
};

export default class RequestGraph<TRequest: HasTypeAndId> extends Graph<
  RequestGraphNode,
  RequestGraphEdgeType
> {
  signal: ?AbortSignal;
  invalidNodeIds: Set<NodeId> = new Set();
  incompleteNodeIds: Set<NodeId> = new Set();
  runValidate: ValidationOpts => Promise<void>;
  onRequestComplete: (request: TRequest) => mixed;
  queue: PromiseQueue<mixed>;
  validationQueue: PromiseQueue<mixed>;
  farm: WorkerFarm;
  config: ParcelConfig;
  options: ParcelOptions;
  globNodeIds: Set<NodeId> = new Set();
  // Unpredictable nodes are requests that cannot be predicted whether they should rerun based on
  // filesystem changes alone. They should rerun on each startup of Parcel.
  unpredicatableNodeIds: Set<NodeId> = new Set();
  depVersionRequestNodeIds: Set<NodeId> = new Set();

  // $FlowFixMe
  static deserialize(opts: SerializedRequestGraph) {
    let deserialized = new RequestGraph<TRequest>(opts);
    deserialized.invalidNodeIds = opts.invalidNodeIds;
    deserialized.globNodeIds = opts.globNodeIds;
    deserialized.depVersionRequestNodeIds = opts.depVersionRequestNodeIds;
    deserialized.unpredicatableNodeIds = opts.unpredicatableNodeIds;
    // $FlowFixMe
    return deserialized;
  }

  // $FlowFixMe
  serialize(): SerializedRequestGraph {
    return {
      ...super.serialize(),
      invalidNodeIds: this.invalidNodeIds,
      globNodeIds: this.globNodeIds,
      unpredicatableNodeIds: this.unpredicatableNodeIds
    };
  }

  initOptions({onRequestComplete, config, options}: RequestGraphOpts) {
    this.options = options;
    this.queue = new PromiseQueue();
    this.validationQueue = new PromiseQueue();
    this.onRequestComplete = onRequestComplete;
    this.config = config;
  }

  async completeValidations() {
    await this.validationQueue.run();
  }

  async completeRequests() {
    for (let id of this.invalidNodeIds) {
      let node = nullthrows(this.getNode(id));
      this.processRequestNode(node);
    }

    await this.queue.run();

    for (let id of this.incompleteNodeIds) {
      let node = nullthrows(this.getNode(id));
      this.processRequestNode(node);
    }

    await this.queue.run();
  }

  addNode(node: RequestGraphNode) {
    if (!this.hasNode(node.id)) {
      if (node.type === 'request') {
        this.incompleteNodeIds.add(node.id);
        let isInvalidationPhase = this.invalidNodeIds.size > 0;
        if (!isInvalidationPhase) {
          this.processRequestNode(node);
        }
      }

      if (node.type === 'glob') {
        this.globNodeIds.add(node.id);
      }
      // else if (node.type === 'dep_version_request') {
      //   this.depVersionRequestNodeIds.add(node.id);
      // }
    }

    return super.addNode(node);
  }

  removeNode(node: RequestGraphNode) {
    this.invalidNodeIds.delete(node.id);
    if (node.type === 'glob') {
      this.globNodeIds.delete(node.id);
    }
    // } else if (node.type === 'dep_version_request') {
    //   this.depVersionRequestNodeIds.delete(node.id);
    // } else if (node.type === 'config_request') {
    //   this.unpredicatableNodeIds.delete(node.id);
    // }
    return super.removeNode(node);
  }

  addRequest(request: TRequest) {
    let requestNode = nodeFromRequest(request);
    if (!this.hasNode(requestNode.id)) {
      this.addNode(requestNode);
    }
  }

  async processRequestNode(requestNode: RequestNode) {
    let signal = this.signal; // ? is this safe?
    let request = requestNode.value;
    this.queue
      .add(async () => {
        let result = await request.run();
        assertSignalNotAborted(signal);

        if (!this.hasNode(requestNode.id)) {
          return;
        }
        request.addResultToGraph(requestNode, result, this);

        this.invalidNodeIds.delete(requestNode.id);
        this.incompleteNodeIds.delete(requestNode.id);

        // ? What should happen if this fails
        this.onRequestComplete(request);

        return result;
      })
      .catch(() => {
        // Do nothing
        // This is catching a promise wrapped around the promise returning function.
        // The promise queue will still reject
      });
  }

  // validate(requestNode: AssetRequestNode) {
  //   return this.runValidate({
  //     request: requestNode.value,
  //     loadConfig: this.loadConfigHandle,
  //     parentNodeId: requestNode.id,
  //     options: this.options
  //   });
  // }

  connectFile(requestNode: RequestNode, filePath: FilePath) {
    if (!this.hasNode(requestNode.id)) {
      return;
    }

    let fileNode = nodeFromFilePath(filePath);
    if (!this.hasNode(fileNode.id)) {
      this.addNode(fileNode);
    }

    if (!this.hasEdge(requestNode.id, fileNode.id)) {
      this.addEdge(requestNode.id, fileNode.id);
    }
  }

  connectGlob(requestNode: RequestNode, glob: Glob) {
    if (!this.hasNode(requestNode.id)) {
      return;
    }

    let globNode = nodeFromGlob(glob);
    if (!this.hasNode(globNode.id)) {
      this.addNode(globNode);
    }

    if (!this.hasEdge(requestNode.id, globNode.id)) {
      this.addEdge(requestNode.id, globNode.id);
    }
  }

  // TODO: attach all sub/secondary requests directly to primary requests and just invalidate parent nodes
  invalidateNode(node: RequestNode) {
    if (this.hasNode(node.id)) {
      this.invalidNodeIds.add(node.id);
    }
  }

  invalidateUnpredictableNodes() {
    for (let nodeId of this.unpredicatableNodeIds) {
      let node = nullthrows(this.getNode(nodeId));
      invariant(node.type !== 'file' && node.type !== 'glob');
      this.invalidateNode(node);
    }
  }

  // getMainRequestNode(node: SubRequestNode) {
  //   let [parentNode] = this.getNodesConnectedTo(node);
  //   if (parentNode.type === 'config_request') {
  //     [parentNode] = this.getNodesConnectedTo(parentNode);
  //   }
  //   invariant(parentNode.type !== 'file' && parentNode.type !== 'glob');
  //   return parentNode;
  // }

  invalidateOnFileUpdate(requestNode: RequestNode, filePath: FilePath) {
    let fileNode = nodeFromFilePath(filePath);
    if (!this.hasNode(fileNode.id)) {
      this.addNode(fileNode);
    }

    if (!this.hasEdge(requestNode.id, fileNode.id, 'invalidated_by_update')) {
      this.addEdge(requestNode.id, fileNode.id, 'invalidated_by_update');
    }
  }

  invalidateOnFileDelete(requestNode: RequestNode, filePath: FilePath) {
    let fileNode = nodeFromFilePath(filePath);
    if (!this.hasNode(fileNode.id)) {
      this.addNode(fileNode);
    }

    if (!this.hasEdge(requestNode.id, fileNode.id, 'invalidated_by_delete')) {
      this.addEdge(requestNode.id, fileNode.id, 'invalidated_by_delete');
    }
  }

  invalidateOnFileCreate(requestNode: RequestNode, glob: Glob) {
    let globNode = nodeFromGlob(glob);
    if (!this.hasNode(globNode.id)) {
      this.addNode(globNode);
    }

    if (!this.hasEdge(requestNode.id, globNode.id, 'invalidated_by_create')) {
      this.addEdge(requestNode.id, globNode.id, 'invalidated_by_create');
    }
  }

  respondToFSEvents(events: Array<Event>): boolean {
    let isInvalid = false;

    for (let {path, type} of events) {
      // TODO: invalidate depVersionRequestNodes in AssetGraphBuilder
      let node = this.getNode(path);

      // sometimes mac os reports update events as create events
      // if it was a create event, but the file already exists in the graph, then we can assume it was actually an update event
      if (node && (type === 'create' || type === 'update')) {
        for (let connectedNode of this.getNodesConnectedTo(
          node,
          'invalidated_by_update'
        )) {
          this.invalidateNode(connectedNode);
          isInvalid = true;
        }
      } else if (type === 'create') {
        for (let id of this.globNodeIds) {
          let globNode = this.getNode(id);
          invariant(globNode && globNode.type === 'glob');

          if (isGlobMatch(path, globNode.value)) {
            let connectedNodes = this.getNodesConnectedTo(
              globNode,
              'invalidated_by_create'
            );
            for (let connectedNode of connectedNodes) {
              this.invalidateNode(connectedNode);
              isInvalid = true;
            }
          }
        }
      } else if (node && type === 'delete') {
        for (let connectedNode of this.getNodesConnectedTo(
          node,
          'invalidated_by_delete'
        )) {
          this.invalidateNode(connectedNode);
          isInvalid = true;
        }
      }
    }

    return isInvalid;
  }
}
