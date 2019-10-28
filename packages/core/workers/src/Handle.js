// @flow

import type {WorkerApi} from './';

import {registerSerializableClass} from '@parcel/utils';

import {child} from './childState';
import packageJson from '../package.json';

let HANDLE_ID = 0;

export type HandleFunction = (...args: Array<any>) => any;

type HandleOpts = {|
  fn: HandleFunction,
  childId?: ?number,
  workerApi: WorkerApi
|};

const handleById: Map<number, Handle> = new Map();

export default class Handle {
  id: number;
  childId: ?number;
  fn: HandleFunction;
  workerApi: WorkerApi;

  constructor(opts: HandleOpts) {
    this.id = ++HANDLE_ID;
    this.fn = opts.fn;
    this.childId = opts.childId;
    this.workerApi = opts.workerApi;
    if (process.send == null) {
      console.log('CREATING HANDLE IN MAIN WITH ID', this.id, process.pid);
    }
    handleById.set(this.id, this);
    if (process.send == null) {
      console.log('MAIN HANDLES AFTER SET', handleById, process.pid);
    }
  }

  dispose() {
    if (process.send == null) {
      console.log('DISPOSING OF HANDLE', this.id);
    }
    handleById.delete(this.id);
  }

  serialize() {
    return {
      id: this.id,
      childId: this.childId
    };
  }

  static deserialize(opts: {|id: number, childId?: number|}) {
    return function(...args: Array<mixed>) {
      let workerApi;
      if (child) {
        workerApi = child.workerApi;
      } else {
        let handle = handleById.get(opts.id);
        if (!handle) {
          console.log('NO HANDLE WITH ID FOUND', opts.id, process.pid);
          if (process.send == null)
            console.log('HANDLES WERE', handleById, process.pid);

          throw new Error(
            'Corresponding Handle was not found. It may have been disposed.'
          );
        }
        workerApi = handle.workerApi;
      }

      if (opts.childId != null && child) {
        throw new Error('Cannot call another child from a child');
      }

      if (opts.childId != null && workerApi.callChild) {
        return workerApi.callChild(opts.childId, {handle: opts.id, args});
      }

      return workerApi.callMaster({handle: opts.id, args}, true);
    };
  }
}

// Register the Handle as a serializable class so that it will properly be deserialized
// by anything that uses WorkerFarm.
registerSerializableClass(`${packageJson.version}:Handle`, Handle);
