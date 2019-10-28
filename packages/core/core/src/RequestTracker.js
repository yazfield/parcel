// @flow strict-local

import type {AbortSignal} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
import type {File, FilePath, Glob} from '@parcel/types';
import type {Event} from '@parcel/watcher';
import type {NodeId} from './types';

import invariant from 'assert';
import nullthrows from 'nullthrows';
import {isGlobMatch, md5FromObject} from '@parcel/utils';
import Graph, {type GraphOpts} from './Graph';
import {assertSignalNotAborted} from './utils';

type SerializedRequestGraph = {|
  ...GraphOpts<RequestGraphNode>,
  invalidNodeIds: Set<NodeId>,
  globNodeIds: Set<NodeId>,
  depVersionRequestNodeIds: Set<NodeId>
|};

type FileNode = {|id: string, +type: 'file', value: File|};
type GlobNode = {|id: string, +type: 'glob', value: Glob|};
type RequestNode = {|
  id: string,
  +type: 'request',
  value: {|id: string, type: string, request: mixed, result?: mixed|}
|};
type RequestGraphNode = RequestNode | FileNode | GlobNode;

type RequestGraphEdgeType =
  | 'subrequest'
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
  id: string,
  type: string,
  ...
};

export class RequestGraph extends Graph<
  RequestGraphNode,
  RequestGraphEdgeType
> {
  invalidNodeIds: Set<NodeId> = new Set();
  incompleteNodeIds: Set<NodeId> = new Set();
  globNodeIds: Set<NodeId> = new Set();
  // Unpredictable nodes are requests that cannot be predicted whether they should rerun based on
  // filesystem changes alone. They should rerun on each startup of Parcel.
  unpredicatableNodeIds: Set<NodeId> = new Set();

  // $FlowFixMe
  static deserialize(opts: SerializedRequestGraph) {
    let deserialized = new RequestGraph();
    deserialized.invalidNodeIds = opts.invalidNodeIds;
    deserialized.globNodeIds = opts.globNodeIds;
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

  addNode(node: RequestGraphNode) {
    if (!this.hasNode(node.id)) {
      if (node.type === 'glob') {
        this.globNodeIds.add(node.id);
      }
    }

    return super.addNode(node);
  }

  removeNode(node: RequestGraphNode) {
    this.invalidNodeIds.delete(node.id);
    this.incompleteNodeIds.delete(node.id);
    if (node.type === 'glob') {
      this.globNodeIds.delete(node.id);
    }
    return super.removeNode(node);
  }

  addRequest(request: HasTypeAndId) {
    let requestNode = nodeFromRequest(request);
    if (!this.hasNode(requestNode.id)) {
      this.addNode(requestNode);
    } else {
      requestNode = this.getNode(requestNode.id);
    }
    return requestNode;
  }

  completeRequest(requestNode) {
    this.invalidNodeIds.delete(requestNode.id);
    this.incompleteNodeIds.delete(requestNode.id);
  }

  replaceSubrequests(
    requestNode: RequestNode,
    subrequestNodes: Array<RequestNode>
  ) {
    if (!this.hasNode(requestNode.id)) {
      this.addNode(requestNode);
    }

    for (let subrequestNode of subrequestNodes) {
      this.invalidNodeIds.delete(subrequestNode.id);
    }

    this.replaceNodesConnectedTo(
      requestNode,
      subrequestNodes,
      null,
      'subrequest'
    );
  }

  invalidateNode(node: RequestGraphNode) {
    invariant(node.type === 'request');
    if (this.hasNode(node.id)) {
      this.invalidNodeIds.add(node.id);
      this.clearInvalidations(node);

      let parentNodes = this.getNodesConnectedTo(node, 'subrequest');
      for (let parentNode of parentNodes) {
        this.invalidateNode(parentNode);
      }
    }
  }

  invalidateUnpredictableNodes() {
    for (let nodeId of this.unpredicatableNodeIds) {
      let node = nullthrows(this.getNode(nodeId));
      invariant(node.type !== 'file' && node.type !== 'glob');
      this.invalidateNode(node);
    }
  }

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

  clearInvalidations(node) {
    this.replaceNodesConnectedTo(node, [], null, 'invalidated_by update');
    this.replaceNodesConnectedTo(node, [], null, 'invalidated_by delete');
    this.replaceNodesConnectedTo(node, [], null, 'invalidated_by create');
  }

  respondToFSEvents(events: Array<Event>): boolean {
    let isInvalid = false;

    for (let {path, type} of events) {
      let node = this.getNode(path);

      // sometimes mac os reports update events as create events
      // if it was a create event, but the file already exists in the graph,
      // then we can assume it was actually an update event
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

function isInvalid(request: Request, requestGraph: RequestGraph) {
  return requestGraph.invalidNodeIds.has(request.id);
}

export function generateRequestId(type: string, request: JSONObject | string) {
  return md5FromObject({type, request});
}

export interface RequestRunner<TRequest, TResult> {
  run(TRequest): TResult;
  updateGraph(TRequest, TResult, RequestGraph): void;
}

export default class RequestTracker<TRequest> {
  runnerMap: {[string]: RequestRunner<TRequest>};
  requestGraph: RequestGraph;
  invalidRequestIds: Set<string>;
  incompleteRequestIds: Set<string>;

  constructor({runnerMap, requestGraph}) {
    this.runnerMap = runnerMap;
    this.requestGraph = requestGraph || new RequestGraph();
    this.invalidRequestIds = new Set();
    this.incompleteRequestIds = new Set();
  }

  async runRequest(
    type: string,
    request: HasTypeAndId,
    {
      signal,
      parentRequest
    }: {|signal: ?AbortSignal, parentRequest?: HasTypeAndId|} = {}
  ) {
    let requestNode = this.requestGraph.getNode(request.id);

    if (requestNode && !isInvalid(request, this.requestGraph)) {
      invariant(requestNode.type === 'request');
      return requestNode.value.result;
    } else if (!requestNode) {
      let id = generateRequestId(type, request);
      requestNode = this.requestGraph.addRequest({id, type, request});
    }

    let runner = this.runnerMap[type];
    nullthrows(runner, `No runner configured for request type ${type}`);
    let result = await runner.run(request, this.requestGraph);
    assertSignalNotAborted(signal);

    if (!this.requestGraph.hasNode(requestNode.id)) {
      return;
    }

    // This function should clear invalid/incomplete status and add result to the value
    this.requestGraph.completeRequest(requestNode);

    await runner.updateGraph(requestNode, result, this.requestGraph);

    return result;
  }

  removeRequest(request) {
    this.requestGraph.removeNode(request.id);
  }

  replaceSubrequests(request, subrequests) {}

  respondToFSEvents(events: Array<Event>): boolean {
    return this.requestGraph.respondToFSEvents(events);
  }
}
