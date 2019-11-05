// @flow strict-local

import type {
  AsyncSubscription,
  BundleGraph as IBundleGraph,
  BuildEvent,
  InitialParcelOptions
} from '@parcel/types';
import type {ParcelOptions} from './types';

import invariant from 'assert';
import nullthrows from 'nullthrows';
import path from 'path';
import resolveOptions from './resolveOptions';
import {ValueEmitter} from '@parcel/events';
import {PromiseQueue} from '@parcel/utils';

export default class Parcel {
  #assetGraphBuilder; // AssetGraphBuilder
  #runtimesAssetGraphBuilder; // AssetGraphBuilder
  #bundlerRunner; // BundlerRunner
  #packagerRunner; // PackagerRunner
  #config;
  #farm; // WorkerFarm
  #initialized = false; // boolean
  #initialOptions; // InitialParcelOptions;
  #reporterRunner; // ReporterRunner
  #resolvedOptions = null; // ?ParcelOptions
  #runPackage; // (bundle: IBundle, bundleGraph: InternalBundleGraph) => Promise<Stats>;
  #watchAbortController; // AbortController
  #watchQueue = new PromiseQueue<?BuildEvent>({maxConcurrent: 1}); // PromiseQueue<?BuildEvent>
  #watchEvents = new ValueEmitter<
    | {|
        +error: Error,
        +buildEvent?: void
      |}
    | {|
        +buildEvent: BuildEvent,
        +error?: void
      |}
  >();
  #watcherSubscription; // AsyncSubscription
  #watcherCount = 0; // number

  constructor(options: InitialParcelOptions) {
    this.#initialOptions = options;
  }

  async init(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    let resolvedOptions: ParcelOptions = await resolveOptions(
      this.#initialOptions
    );
    this.#resolvedOptions = resolvedOptions;
    this.#initialized = true;
  }

  async run(): Promise<IBundleGraph> {
    if (!this.#initialized) {
      await this.init();
    }

    await this.build();
  }

  async startNextBuild() {
    await this.build();
  }

  async watch(
    cb?: (err: ?Error, buildEvent?: BuildEvent) => mixed
  ): Promise<AsyncSubscription> {
    let watchEventsDisposable;
    if (cb) {
      watchEventsDisposable = this.#watchEvents.addListener(
        ({error, buildEvent}) => cb(error, buildEvent)
      );
    }

    if (this.#watcherCount === 0) {
      if (!this.#initialized) {
        await this.init();
      }

      this.#watcherSubscription = await this._getWatcherSubscription();

      // Kick off a first build, but don't await its results. Its results will
      // be provided to the callback.
      this.#watchQueue.add(() => this.startNextBuild());
      this.#watchQueue.run();
    }

    this.#watcherCount++;

    let unsubscribePromise;
    const unsubscribe = async () => {
      if (watchEventsDisposable) {
        watchEventsDisposable.dispose();
      }

      this.#watcherCount--;
      if (this.#watcherCount === 0) {
        await nullthrows(this.#watcherSubscription).unsubscribe();
        this.#watcherSubscription = null;
      }
    };

    return {
      unsubscribe() {
        if (unsubscribePromise == null) {
          unsubscribePromise = unsubscribe();
        }

        return unsubscribePromise;
      }
    };
  }

  build(): Promise<BuildEvent> {
    console.log('BUILDING');
  }

  _getWatcherSubscription(): Promise<AsyncSubscription> {
    invariant(this.#watcherSubscription == null);

    let resolvedOptions = nullthrows(this.#resolvedOptions);
    let vcsDirs = ['.git', '.hg'].map(dir =>
      path.join(resolvedOptions.projectRoot, dir)
    );
    let ignore = [resolvedOptions.cacheDir, ...vcsDirs];
    let opts = {ignore};

    return resolvedOptions.inputFS.watch(
      resolvedOptions.projectRoot,
      (err, _events) => {
        let events = _events.filter(e => !e.path.includes('.cache'));
        console.log('WITNESSED EVENTS', events);

        if (err) {
          this.#watchEvents.emit({error: err});
          return;
        }

        let isInvalid = true; //this.#assetGraphBuilder.respondToFSEvents(events);
        if (isInvalid && this.#watchQueue.getNumWaiting() === 0) {
          if (this.#watchAbortController) {
            this.#watchAbortController.abort();
          }

          console.log('ENQUEING BUILD');
          this.#watchQueue.add(() => this.startNextBuild());
          console.log('ADDED TO QUEUE');
          this.#watchQueue.run();
        }
      },
      opts
    );
  }
}
