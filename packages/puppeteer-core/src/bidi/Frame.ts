/**
 * Copyright 2023 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {
  first,
  firstValueFrom,
  forkJoin,
  from,
  fromEvent,
  map,
  merge,
  raceWith,
  type Observable,
  zip,
  throwError,
  debounceTime,
  bufferCount,
  mergeMap,
} from '../../third_party/rxjs/rxjs.js';
import type {CDPSession} from '../api/CDPSession.js';
import type {ElementHandle} from '../api/ElementHandle.js';
import {
  Frame,
  FrameEvent,
  throwIfDetached,
  type GoToOptions,
  type WaitForOptions,
} from '../api/Frame.js';
import {PageEvent, type WaitForSelectorOptions} from '../api/Page.js';
import {UnsupportedOperation} from '../common/Errors.js';
import {EventSubscription} from '../common/EventEmitter.js';
import type {TimeoutSettings} from '../common/TimeoutSettings.js';
import type {Awaitable, NodeFor} from '../common/types.js';
import {timeout} from '../common/util.js';
import {DisposableStack} from '../util/disposable.js';

import type {BrowsingContext} from './BrowsingContext.js';
import {ExposeableFunction} from './ExposedFunction.js';
import {BidiHTTPResponse} from './HTTPResponse.js';
import {
  getBiDiLifecycleEvent,
  getBiDiReadinessState,
  rewriteNavigationError,
} from './lifecycle.js';
import type {BidiPage} from './Page.js';
import type {Sandbox} from './Sandbox.js';
import {BidiRequest} from './Request.js';
import {BidiHTTPRequest} from './HTTPRequest.js';
import {Navigation} from './Navigation.js';

/**
 * Puppeteer's Frame class could be viewed as a BiDi BrowsingContext implementation
 * @internal
 */
export class BidiFrame extends Frame {
  static createRootFrame(
    page: BidiPage,
    context: BrowsingContext,
    timeoutSettings: TimeoutSettings
  ): BidiFrame {
    return new BidiFrame(page, undefined, context, timeoutSettings);
  }

  static #rootOnly<T extends (this: BidiFrame, ...args: unknown[]) => unknown>(
    target: T,
    _: unknown
  ) {
    return function (this: BidiFrame, ...args: Parameters<T>) {
      if (this.#parent) {
        throw new Error(`Can only call ${target.name} on top-level frames.`);
      }
      return target.call(this, ...args);
    };
  }

  #page: BidiPage;
  #parent: BidiFrame | undefined;
  #context: BrowsingContext;
  #timeoutSettings: TimeoutSettings;

  #children = new Map<string, BidiFrame>();

  #disposables = new DisposableStack();

  private constructor(
    page: BidiPage,
    parent: BidiFrame | undefined,
    context: BrowsingContext,
    timeoutSettings: TimeoutSettings
  ) {
    super();
    this.#page = page;
    this.#parent = parent;
    this.#context = context;
    this.#timeoutSettings = timeoutSettings;

    this.#disposables.use(
      new EventSubscription(
        this.#context,
        'created',
        (context: BrowsingContext) => {
          const frame = new BidiFrame(
            this.#page,
            this,
            context,
            this.#timeoutSettings
          );
          this.#children.set(context.id, frame);
          this.#page.emit(PageEvent.FrameAttached, frame);

          this.#disposables.use(
            new EventSubscription(
              context,
              'destroyed',
              (destroyedContext: BrowsingContext) => {
                if (destroyedContext !== context) {
                  return;
                }
                this.#children.delete(context.id);
              }
            )
          );
        }
      )
    );

    this.#disposables.use(
      new EventSubscription(
        this.#context,
        'destroyed',
        (context: BrowsingContext) => {
          if (context !== this.#context) {
            return;
          }
          this.#disposables.dispose();
          this.emit(FrameEvent.FrameDetached, this);
          this.page().emit(PageEvent.FrameDetached, this);
          this.removeAllListeners();
        }
      )
    );
  }

  *getDescendants(): Iterable<BidiFrame> {
    const frames: BidiFrame[] = [this];
    for (let frame = frames.shift(); frame; frame = frames.shift()) {
      yield frame;
      frames.push(...frame.childFrames());
    }
  }

  override get detached(): boolean {
    return this.#context.disposed;
  }

  override get _id(): string {
    return this.#context.id;
  }

  override get client(): CDPSession {
    return this.context().cdpSession;
  }

  override mainRealm(): Sandbox {
    throw new UnsupportedOperation('Not implemented');
  }

  override isolatedRealm(): Sandbox {
    throw new UnsupportedOperation('Not implemented');
  }

  override page(): BidiPage {
    return this.#page;
  }

  override isOOPFrame(): never {
    throw new UnsupportedOperation();
  }

  override url(): string {
    return this.#context.url;
  }

  override parentFrame(): BidiFrame | null {
    return this.#parent ?? null;
  }

  override childFrames(): BidiFrame[] {
    return [...this.#children.values()];
  }

  @throwIfDetached
  override async goto(
    url: string,
    options: GoToOptions = {}
  ): Promise<BidiHTTPResponse | null> {
    void this.#context.navigate(url);
    return await this.waitForNavigation(options);
  }

  @throwIfDetached
  override async setContent(
    html: string,
    options: WaitForOptions = {}
  ): Promise<void> {
    void this.setFrameContent(html);
    await this.waitForNavigation(options);
  }

  context(): BrowsingContext {
    return this.#context;
  }

  @throwIfDetached
  override async waitForNavigation(
    options: WaitForOptions = {}
  ): Promise<BidiHTTPResponse | null> {
    const {
      waitUntil = 'load',
      timeout: ms = this.#timeoutSettings.navigationTimeout(),
    } = options;

    const [eventName, requestCount] = getBiDiLifecycleEvent(waitUntil);

    const [readiness, networkIdle] = getBiDiReadinessState(waitUntil);

    const response$ = from(this.#context.navigate(url, readiness)).pipe(
      mergeMap(navigation => {
        const request = new BidiHTTPRequest(navigation.request);
        return new BidiHTTPResponse(request);
      })
    );
    return await firstValueFrom(response$);
  }

  override waitForDevicePrompt(): never {
    throw new UnsupportedOperation();
  }

  #exposedFunctions = new Map<string, ExposeableFunction<never[], unknown>>();
  async exposeFunction<Args extends unknown[], Ret>(
    name: string,
    apply: (...args: Args) => Awaitable<Ret>
  ): Promise<void> {
    if (this.#exposedFunctions.has(name)) {
      throw new Error(
        `Failed to add page binding with name ${name}: globalThis['${name}'] already exists!`
      );
    }
    const exposeable = new ExposeableFunction(this, name, apply);
    this.#exposedFunctions.set(name, exposeable);
    try {
      await exposeable.expose();
    } catch (error) {
      this.#exposedFunctions.delete(name);
      throw error;
    }
  }

  override waitForSelector<Selector extends string>(
    selector: Selector,
    options?: WaitForSelectorOptions
  ): Promise<ElementHandle<NodeFor<Selector>> | null> {
    if (selector.startsWith('aria')) {
      throw new UnsupportedOperation(
        'ARIA selector is not supported for BiDi!'
      );
    }

    return super.waitForSelector(selector, options);
  }
}
