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

import type {Observable} from '../../third_party/rxjs/rxjs.js';
import {
  bufferCount,
  concat,
  debounceTime,
  filterAsync,
  firstValueFrom,
  from,
  fromEvent,
  map,
  merge,
  of,
  raceWith,
  switchMap,
  zip,
} from '../../third_party/rxjs/rxjs.js';
import type {CDPSession} from '../api/CDPSession.js';
import type {BoundingBox, ElementHandle} from '../api/ElementHandle.js';
import type {FrameEvents} from '../api/Frame.js';
import {
  Frame,
  FrameEvent,
  throwIfDetached,
  type GoToOptions,
  type WaitForOptions,
} from '../api/Frame.js';
import type {HTTPRequest} from '../api/HTTPRequest.js';
import type {HTTPResponse} from '../api/HTTPResponse.js';
import type {
  AwaitablePredicate,
  ScreenshotOptions,
  WaitTimeoutOptions,
} from '../api/Page.js';
import {PageEvent, type WaitForSelectorOptions} from '../api/Page.js';
import {UnsupportedOperation} from '../common/Errors.js';
import {EventSubscription} from '../common/EventEmitter.js';
import type {PDFOptions} from '../common/PDFOptions.js';
import type {TimeoutSettings} from '../common/TimeoutSettings.js';
import type {Awaitable, NodeFor} from '../common/types.js';
import {
  NETWORK_IDLE_TIME,
  fromEmitterEvent,
  importFSPromises,
  parsePDFOptions,
  timeout,
} from '../common/util.js';
import {DisposableStack} from '../util/disposable.js';

import {BidiCdpSession} from './BidiCdpSession.js';
import type {BidiBrowserContext} from './BrowserContext.js';
import type {BrowsingContext} from './BrowsingContext.js';
import {BidiElementHandle} from './ElementHandle.js';
import {ExposeableFunction} from './ExposedFunction.js';
import {BidiHTTPRequest} from './HTTPRequest.js';
import type {BidiHTTPResponse} from './HTTPResponse.js';
import type {Navigation} from './Navigation.js';
import type {BidiPage} from './Page.js';
import type {BidiRequest} from './Request.js';
import type {Sandbox} from './Sandbox.js';

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

  static #rootOnly<T extends unknown[], R>(
    target: (this: BidiFrame, ...args: T) => R,
    _: unknown
  ): (this: BidiFrame, ...args: T) => R {
    return function (this: BidiFrame, ...args: T) {
      if (this.#parent) {
        throw new Error(`Can only call ${target.name} on top-level frames.`);
      }
      return target.call(this, ...args);
    };
  }

  readonly #page: BidiPage;
  readonly #parent: BidiFrame | undefined;
  readonly #context: BrowsingContext;
  readonly #timeoutSettings: TimeoutSettings;

  readonly #children = new Map<string, BidiFrame>();
  // A map of ongoing requests.
  readonly #requests = new Map<string, BidiHTTPRequest>();
  readonly #disposables = new DisposableStack();

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

    this.#disposables.use(
      new EventSubscription(
        this.#context,
        'request',
        (request: BidiRequest) => {
          const httpRequest = new BidiHTTPRequest(this, request);
          this.#requests.set(request.id, httpRequest);

          this.bubbleEmit(FrameEvent.Request, httpRequest);
          this.page().emit(PageEvent.Request, httpRequest);
        }
      )
    );
  }

  get browserContext(): BidiBrowserContext {
    return this.#context.browserContext;
  }

  override get detached(): boolean {
    return this.#context.disposed;
  }

  override get _id(): string {
    return this.#context.id;
  }

  override get client(): CDPSession {
    return this.#context.cdpSession;
  }

  bubbleEmit<FrameEvent extends keyof FrameEvents>(
    event: FrameEvent,
    data: FrameEvents[FrameEvent]
  ): void {
    this.emit(event, data);
    if (this.#parent) {
      this.#parent.bubbleEmit(event, data);
    }
  }

  *getDescendants(): Iterable<BidiFrame> {
    const frames: BidiFrame[] = [this];
    for (let frame = frames.shift(); frame; frame = frames.shift()) {
      yield frame;
      frames.push(...frame.childFrames());
    }
  }

  @throwIfDetached
  async createCDPSession(): Promise<CDPSession> {
    const {sessionId} = await this.#context.cdpSession.send(
      'Target.attachToTarget',
      {
        targetId: this._id,
        flatten: true,
      }
    );
    return new BidiCdpSession(this.#context, sessionId);
  }

  @throwIfDetached
  @BidiFrame.#rootOnly
  async bringToFront(): Promise<void> {
    await this.#context.activate();
  }

  @throwIfDetached
  async reload(options?: WaitForOptions): Promise<BidiHTTPResponse | null> {
    void this.#context.reload();
    return await this.waitForNavigation(options);
  }

  @throwIfDetached
  @BidiFrame.#rootOnly
  async close(options?: {runBeforeUnload?: boolean}): Promise<void> {
    await this.#context.close(options?.runBeforeUnload ?? false);
  }

  @throwIfDetached
  @BidiFrame.#rootOnly
  async pdf(options: PDFOptions = {}): Promise<Buffer> {
    const {path = undefined, timeout: ms = this.#timeoutSettings.timeout()} =
      options;
    const {
      printBackground: background,
      margin,
      landscape,
      width,
      height,
      pageRanges: ranges,
      scale,
      preferCSSPageSize,
    } = parsePDFOptions(options, 'cm');

    const pageRanges = ranges ? ranges.split(', ') : [];
    const data = await firstValueFrom(
      from(
        this.#context.print({
          background,
          margin,
          orientation: landscape ? 'landscape' : 'portrait',
          page: {
            width,
            height,
          },
          pageRanges,
          scale,
          shrinkToFit: !preferCSSPageSize,
        })
      ).pipe(raceWith(timeout(ms)))
    );

    const buffer = Buffer.from(data, 'base64');
    if (path) {
      const fs = await importFSPromises();
      await fs.writeFile(path, buffer);
    }
    return buffer;
  }

  @throwIfDetached
  async screenshot(options: Readonly<ScreenshotOptions>): Promise<string> {
    const {clip, type, captureBeyondViewport, quality} = options;
    if (options.omitBackground !== undefined && options.omitBackground) {
      throw new UnsupportedOperation(`BiDi does not support 'omitBackground'.`);
    }
    if (options.optimizeForSpeed !== undefined && options.optimizeForSpeed) {
      throw new UnsupportedOperation(
        `BiDi does not support 'optimizeForSpeed'.`
      );
    }
    if (options.fromSurface !== undefined && !options.fromSurface) {
      throw new UnsupportedOperation(`BiDi does not support 'fromSurface'.`);
    }
    if (clip !== undefined && clip.scale !== undefined && clip.scale !== 1) {
      throw new UnsupportedOperation(
        `BiDi does not support 'scale' in 'clip'.`
      );
    }

    let box: BoundingBox | undefined;
    if (clip) {
      if (captureBeyondViewport) {
        box = clip;
      } else {
        // The clip is always with respect to the document coordinates, so we
        // need to convert this to viewport coordinates when we aren't capturing
        // beyond the viewport.
        const [pageLeft, pageTop] = await this.evaluate(() => {
          if (!window.visualViewport) {
            throw new Error('window.visualViewport is not supported.');
          }
          return [
            window.visualViewport.pageLeft,
            window.visualViewport.pageTop,
          ] as const;
        });
        box = {
          ...clip,
          x: clip.x - pageLeft,
          y: clip.y - pageTop,
        };
      }
    }

    return await this.#context.captureScreenshot({
      origin: captureBeyondViewport ? 'document' : 'viewport',
      format: {
        type: `image/${type}`,
        ...(quality !== undefined ? {quality: quality / 100} : {}),
      },
      ...(box ? {clip: {type: 'box', ...box}} : {}),
    });
  }

  @throwIfDetached
  async focusedFrame(): Promise<BidiFrame> {
    using frame = await this.isolatedRealm().evaluateHandle(() => {
      let frame: HTMLIFrameElement | undefined;
      let win: Window | null = window;
      while (win?.document.activeElement instanceof HTMLIFrameElement) {
        frame = win.document.activeElement;
        win = frame.contentWindow;
      }
      return frame;
    });
    if (!(frame instanceof BidiElementHandle)) {
      return this;
    }
    return await frame.contentFrame();
  }

  #exposedFunctions = new Map<string, ExposeableFunction<never[], unknown>>();
  @throwIfDetached
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

  @throwIfDetached
  async waitForRequest(
    urlOrPredicate: string | AwaitablePredicate<HTTPRequest>,
    options: WaitTimeoutOptions = {}
  ): Promise<HTTPRequest> {
    const {timeout: ms = this.#timeoutSettings.timeout()} = options;

    if (typeof urlOrPredicate === 'string') {
      const url = urlOrPredicate;
      urlOrPredicate = request => {
        return request.url() === url;
      };
    }

    const request$ = merge(
      fromEmitterEvent(this, FrameEvent.Request),
      fromEmitterEvent(this, FrameEvent.RequestFailed),
      fromEmitterEvent(this, FrameEvent.RequestFinished)
    ).pipe(filterAsync(urlOrPredicate));

    return await firstValueFrom(
      request$.pipe(
        raceWith(
          timeout(ms),
          fromEmitterEvent(this, FrameEvent.FrameDetached).pipe(
            map(() => {
              throw new Error('Page closed.');
            })
          )
        )
      )
    );
  }

  @throwIfDetached
  async waitForResponse(
    urlOrPredicate: string | AwaitablePredicate<HTTPResponse>,
    options: WaitTimeoutOptions = {}
  ): Promise<HTTPResponse> {
    const {timeout: ms = this.#timeoutSettings.timeout()} = options;

    if (typeof urlOrPredicate === 'string') {
      const url = urlOrPredicate;
      urlOrPredicate = request => {
        return request.url() === url;
      };
    }

    const request$ = fromEmitterEvent(this, FrameEvent.Response).pipe(
      filterAsync(urlOrPredicate)
    );

    return await firstValueFrom(
      request$.pipe(
        raceWith(
          timeout(ms),
          fromEmitterEvent(this, FrameEvent.FrameDetached).pipe(
            map(() => {
              throw new Error('Page closed.');
            })
          )
        )
      )
    );
  }

  @throwIfDetached
  async waitForNetworkIdle(
    options: {idleTime?: number; timeout?: number} = {}
  ): Promise<void> {
    const {
      idleTime = NETWORK_IDLE_TIME,
      timeout: ms = this.#timeoutSettings.timeout(),
    } = options;

    const idle$ = concat(
      of(null),
      fromEmitterEvent(this, PageEvent.Request),
      fromEmitterEvent(this, PageEvent.RequestFinished),
      fromEmitterEvent(this, PageEvent.RequestFailed),
      fromEmitterEvent(this, PageEvent.Response)
    ).pipe(debounceTime(idleTime));

    await firstValueFrom(
      idle$.pipe(
        raceWith(
          timeout(ms),
          fromEvent(this, PageEvent.Close).pipe(
            map(() => {
              throw new Error('Page closed.');
            })
          )
        )
      )
    );
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

  @throwIfDetached
  override async waitForNavigation(
    options: WaitForOptions = {}
  ): Promise<BidiHTTPResponse | null> {
    let {waitUntil = 'load'} = options;
    const {timeout: ms = this.#timeoutSettings.navigationTimeout()} = options;

    if (!Array.isArray(waitUntil)) {
      waitUntil = [waitUntil];
    }

    let bidiEvent: 'load' | 'dom' | undefined;
    let requestCount = Infinity;
    for (const event of waitUntil) {
      switch (event) {
        case 'load': {
          bidiEvent = 'load';
          break;
        }
        case 'domcontentloaded': {
          bidiEvent = 'dom';
          break;
        }
        case 'networkidle0': {
          requestCount = 0;
          break;
        }
        case 'networkidle2': {
          requestCount = 2;
          break;
        }
      }
    }

    const idle$ = concat(
      of(null),
      (fromEvent(this.#context, 'request') as Observable<BidiRequest>).pipe(
        bufferCount(requestCount + 1, 1)
      )
    ).pipe(debounceTime(500));

    const navigation$ = (
      fromEvent(this.#context, 'navigation') as Observable<Navigation>
    ).pipe(
      switchMap(navigation => {
        if (bidiEvent !== undefined) {
          return fromEvent(navigation, bidiEvent).pipe(
            map(() => {
              return navigation;
            })
          );
        } else {
          return of(navigation);
        }
      })
    );

    const navigation = await firstValueFrom(
      zip(navigation$, idle$).pipe(
        map(([navigation]) => {
          return navigation;
        }),
        raceWith(
          timeout(ms),
          fromEmitterEvent(this, FrameEvent.FrameDetached).pipe(
            map(() => {
              throw new Error('Frame detached.');
            })
          )
        )
      )
    );

    // By now, the request should have come in if any.
    const bidiRequest = await navigation.request();
    if (!bidiRequest) {
      return null;
    }
    const request = new BidiHTTPRequest(this, bidiRequest);
    return request.response();
  }

  override waitForDevicePrompt(): never {
    throw new UnsupportedOperation();
  }

  @throwIfDetached
  override async waitForSelector<Selector extends string>(
    selector: Selector,
    options?: WaitForSelectorOptions
  ): Promise<ElementHandle<NodeFor<Selector>> | null> {
    if (selector.startsWith('aria')) {
      throw new UnsupportedOperation(
        'ARIA selector is not supported for BiDi!'
      );
    }

    return await super.waitForSelector(selector, options);
  }
}
