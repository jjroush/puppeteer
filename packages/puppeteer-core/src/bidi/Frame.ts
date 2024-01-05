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
import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import type {Observable} from '../../third_party/rxjs/rxjs.js';
import {
  bufferCount,
  concat,
  debounceTime,
  filter,
  filterAsync,
  firstValueFrom,
  from,
  map,
  merge,
  mergeMap,
  of,
  raceWith,
  switchMap,
  zip,
} from '../../third_party/rxjs/rxjs.js';
import type {BoundingBox, ElementHandle} from '../api/ElementHandle.js';
import {
  Frame,
  throwIfDetached,
  type GoToOptions,
  type WaitForOptions,
} from '../api/Frame.js';
import type {HTTPRequest} from '../api/HTTPRequest.js';
import type {HTTPResponse} from '../api/HTTPResponse.js';
import {
  PageEvent,
  type AwaitablePredicate,
  type ScreenshotOptions,
  type WaitForSelectorOptions,
  type WaitTimeoutOptions,
} from '../api/Page.js';
import type {ConsoleMessageLocation} from '../common/ConsoleMessage.js';
import {UnsupportedOperation} from '../common/Errors.js';
import type {PDFOptions} from '../common/PDFOptions.js';
import type {TimeoutSettings} from '../common/TimeoutSettings.js';
import type {Awaitable, NodeFor} from '../common/types.js';
import {
  fromEmitterEvent,
  importFSPromises,
  NETWORK_IDLE_TIME,
  parsePDFOptions,
  timeout,
} from '../common/util.js';
import {cached} from '../util/decorators.js';

import type {BidiBrowserContext} from './BrowserContext.js';
import type {BrowsingContext} from './core/BrowsingContext.js';
import {BidiElementHandle} from './ElementHandle.js';
import {ExposeableFunction} from './ExposedFunction.js';
import {BidiHTTPRequest} from './HTTPRequest.js';
import {BidiHTTPResponse} from './HTTPResponse.js';
import type {BidiPage} from './Page.js';
import type {Sandbox} from './Sandbox.js';

/**
 * Puppeteer's Frame class could be viewed as a BiDi BrowsingContext implementation
 * @internal
 */
export class BidiFrame extends Frame {
  @cached((_, context, ___) => {
    return context;
  })
  static create(
    page: BidiPage,
    context: BrowsingContext,
    timeoutSettings: TimeoutSettings
  ): BidiFrame {
    const frame = new BidiFrame(page, context, timeoutSettings);
    void frame.#initialize();
    return frame;
  }

  readonly #page: BidiPage;
  readonly #context: BrowsingContext;
  readonly #timeoutSettings: TimeoutSettings;

  readonly destroyed$: Observable<never>;

  private constructor(
    page: BidiPage,
    context: BrowsingContext,
    timeoutSettings: TimeoutSettings
  ) {
    super();
    this.#page = page;
    this.#context = context;
    this.#timeoutSettings = timeoutSettings;

    this.destroyed$ = fromEmitterEvent(this.#context, 'destroyed').pipe(
      filter(({context}) => {
        return context === this.#context;
      }),
      map(() => {
        throw new Error('Frame detached.');
      })
    );
  }

  get browserContext(): BidiBrowserContext {
    return this.#page.browserContext();
  }

  override get detached(): boolean {
    return this.#context.disposed;
  }

  override get _id(): string {
    return this.#context.id;
  }

  async #initialize(): Promise<void> {
    this.#context.on('request', request => {
      const httpRequest = BidiHTTPRequest.create(this, request);
      this.page().emit(PageEvent.Request, httpRequest);
      request.once('success', data => {
        this.page().emit(
          PageEvent.Response,
          BidiHTTPResponse.create(httpRequest, data)
        );
        this.page().emit(PageEvent.RequestFinished, httpRequest);
      });
      request.once('error', () => {
        this.page().emit(PageEvent.RequestFailed, httpRequest);
      });
    });
    this.#context.on('created', ({context}) => {
      this.page().emit(
        PageEvent.FrameAttached,
        BidiFrame.create(this.page(), context, this.#timeoutSettings)
      );
    });
    this.#context.on('destroyed', ({context}) => {
      if (context === this.#context) {
        this.page().emit(PageEvent.FrameDetached, this);
      }
    });
    this.#context.on('navigation', navigation => {
      this.page().emit(PageEvent.FrameNavigated, this);
      navigation.once('loaded', () => {
        this.page().emit(PageEvent.Load, undefined);
      });
      navigation.once('dom', () => {
        this.page().emit(PageEvent.DOMContentLoaded, undefined);
      });
    });
  }

  @throwIfDetached
  async bringToFront(): Promise<void> {
    await this.#context.activate();
  }

  @throwIfDetached
  async reload(options?: WaitForOptions): Promise<BidiHTTPResponse | null> {
    void this.#context.reload();
    return await this.waitForNavigation(options);
  }

  @throwIfDetached
  async close(options?: {runBeforeUnload?: boolean}): Promise<void> {
    await this.#context.close(options?.runBeforeUnload ?? false);
  }

  @throwIfDetached
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

    return await firstValueFrom(
      fromEmitterEvent(this.#context, 'request')
        .pipe(
          mergeMap(request => {
            return merge(
              of(request),
              fromEmitterEvent(request, 'success'),
              fromEmitterEvent(request, 'error')
            ).pipe(
              map(() => {
                return BidiHTTPRequest.create(this, request);
              })
            );
          }),
          filterAsync(urlOrPredicate)
        )
        .pipe(raceWith(timeout(ms), this.destroyed$))
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

    return await firstValueFrom(
      fromEmitterEvent(this.#context, 'request')
        .pipe(
          mergeMap(request => {
            const httpRequest = BidiHTTPRequest.create(this, request);
            return fromEmitterEvent(request, 'success').pipe(
              map(data => {
                return BidiHTTPResponse.create(httpRequest, data);
              })
            );
          }),
          filterAsync(urlOrPredicate)
        )
        .pipe(raceWith(timeout(ms), this.destroyed$))
    );
  }

  @throwIfDetached
  async waitForNetworkIdle(
    options: {idleTime?: number; timeout?: number; count?: number} = {}
  ): Promise<void> {
    const {
      idleTime = NETWORK_IDLE_TIME,
      timeout: ms = this.#timeoutSettings.timeout(),
      count = 0,
    } = options;

    if (count === Infinity) {
      return;
    }

    await firstValueFrom(
      concat(
        of(null),
        fromEmitterEvent(this.#context, 'request').pipe(
          mergeMap(request => {
            return merge(
              of(request),
              fromEmitterEvent(request, 'success'),
              fromEmitterEvent(request, 'error'),
              fromEmitterEvent(request, 'redirect')
            );
          }),
          bufferCount(count + 1, 1)
        )
      ).pipe(debounceTime(idleTime), raceWith(timeout(ms), this.destroyed$))
    );
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

    let bidiEvent: 'loaded' | 'dom' | undefined;
    let requestCount = Infinity;
    for (const event of waitUntil) {
      switch (event) {
        case 'load': {
          bidiEvent = 'loaded';
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

    return await firstValueFrom(
      zip(
        fromEmitterEvent(this.#context, 'navigation').pipe(
          switchMap(navigation => {
            if (bidiEvent !== undefined) {
              return fromEmitterEvent(navigation, bidiEvent).pipe(
                map(() => {
                  return navigation;
                })
              );
            } else {
              return of(navigation);
            }
          })
        ),
        from(
          this.waitForNetworkIdle({
            idleTime: 500,
            timeout: ms,
            count: requestCount,
          })
        )
      ).pipe(
        map(([navigation]) => {
          const request = navigation.request();
          if (!request) {
            return null;
          }
          return BidiHTTPRequest.create(this, request).response();
        }),
        raceWith(timeout(ms), this.destroyed$)
      )
    );
  }

  @throwIfDetached
  async go(
    delta: number,
    options?: WaitForOptions
  ): Promise<HTTPResponse | null> {
    void this.#context.traverseHistory(delta);
    return await this.waitForNavigation(options);
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
    return this.#context.parent
      ? BidiFrame.create(
          this.#page,
          this.#context.parent,
          this.#timeoutSettings
        )
      : null;
  }

  override childFrames(): BidiFrame[] {
    return [...this.#context.children].map(child => {
      return BidiFrame.create(this.#page, child, this.#timeoutSettings);
    });
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

function isConsoleLogEntry(
  event: Bidi.Log.Entry
): event is Bidi.Log.ConsoleLogEntry {
  return event.type === 'console';
}

function isJavaScriptLogEntry(
  event: Bidi.Log.Entry
): event is Bidi.Log.JavascriptLogEntry {
  return event.type === 'javascript';
}

function getStackTraceLocations(
  stackTrace?: Bidi.Script.StackTrace
): ConsoleMessageLocation[] {
  const stackTraceLocations: ConsoleMessageLocation[] = [];
  if (stackTrace) {
    for (const callFrame of stackTrace.callFrames) {
      stackTraceLocations.push({
        url: callFrame.url,
        lineNumber: callFrame.lineNumber,
        columnNumber: callFrame.columnNumber,
      });
    }
  }
  return stackTraceLocations;
}
