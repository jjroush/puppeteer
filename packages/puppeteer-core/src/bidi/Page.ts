/**
 * Copyright 2022 Google Inc. All rights reserved.
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

import type {Readable} from 'stream';

import type Protocol from 'devtools-protocol';

import type {CDPSession} from '../api/CDPSession.js';
import type {Frame} from '../api/Frame.js';
import {FrameEvent, type WaitForOptions} from '../api/Frame.js';
import type {HTTPRequest} from '../api/HTTPRequest.js';
import type {HTTPResponse} from '../api/HTTPResponse.js';
import type {AwaitablePredicate, WaitTimeoutOptions} from '../api/Page.js';
import {
  Page,
  PageEvent,
  type GeolocationOptions,
  type MediaFeature,
  type NewDocumentScriptEvaluation,
  type ScreenshotOptions,
} from '../api/Page.js';
import {Accessibility} from '../cdp/Accessibility.js';
import {Coverage} from '../cdp/Coverage.js';
import {EmulationManager as CdpEmulationManager} from '../cdp/EmulationManager.js';
import {Tracing} from '../cdp/Tracing.js';
import {UnsupportedOperation} from '../common/Errors.js';
import {EventSubscription} from '../common/EventEmitter.js';
import type {PDFOptions} from '../common/PDFOptions.js';
import type {Awaitable} from '../common/types.js';
import {evaluationString} from '../common/util.js';
import type {Viewport} from '../common/Viewport.js';
import {assert} from '../util/assert.js';
import {DisposableStack} from '../util/disposable.js';
import {isErrorLike} from '../util/ErrorLike.js';

import type {BidiBrowser} from './Browser.js';
import type {BidiBrowserContext} from './BrowserContext.js';
import type {BrowsingContext} from './BrowsingContext.js';
import type {BidiConnection} from './Connection.js';
import {EmulationManager} from './EmulationManager.js';
import {BidiFrame} from './Frame.js';
import type {BidiHTTPResponse} from './HTTPResponse.js';
import {BidiKeyboard, BidiMouse, BidiTouchscreen} from './Input.js';
import type {BidiJSHandle} from './JSHandle.js';
import {createBidiHandle} from './Realm.js';
import type {BiDiPageTarget} from './Target.js';

/**
 * @internal
 */
export class BidiPage extends Page {
  #frame: BidiFrame;

  #accessibility: Accessibility;
  #cdpEmulationManager: CdpEmulationManager;
  #coverage: Coverage;
  #emulationManager: EmulationManager;
  #keyboard: BidiKeyboard;
  #mouse: BidiMouse;
  #touchscreen: BidiTouchscreen;
  #tracing: Tracing;

  readonly #disposables = new DisposableStack();
  #viewport: Viewport | null = null;

  constructor(context: BrowsingContext) {
    super();
    this.#frame = BidiFrame.createRootFrame(
      this,
      context,
      this._timeoutSettings
    );

    // TODO: https://github.com/w3c/webdriver-bidi/issues/443
    this.#accessibility = new Accessibility(context.cdpSession);
    this.#cdpEmulationManager = new CdpEmulationManager(context.cdpSession);
    this.#coverage = new Coverage(context.cdpSession);
    this.#emulationManager = new EmulationManager(context);
    this.#keyboard = new BidiKeyboard(this);
    this.#mouse = new BidiMouse(context);
    this.#touchscreen = new BidiTouchscreen(context);
    this.#tracing = new Tracing(context.cdpSession);

    this.#disposables.use(
      new EventSubscription(
        this.#frame,
        FrameEvent.FrameDetached,
        (frame: Frame) => {
          if (frame !== this.#frame) {
            return;
          }
          this.#disposables.dispose();
          this.emit(PageEvent.Close, undefined);
          this.removeAllListeners();
        }
      )
    );
  }

  get #connection(): BidiConnection {
    return this.browser().connection;
  }

  override get accessibility(): Accessibility {
    return this.#accessibility;
  }

  override get tracing(): Tracing {
    return this.#tracing;
  }

  override get coverage(): Coverage {
    return this.#coverage;
  }

  override get mouse(): BidiMouse {
    return this.#mouse;
  }

  override get touchscreen(): BidiTouchscreen {
    return this.#touchscreen;
  }

  override get keyboard(): BidiKeyboard {
    return this.#keyboard;
  }

  _client(): CDPSession {
    return this.#frame.client;
  }

  async focusedFrame(): Promise<BidiFrame> {
    return await this.#frame.focusedFrame();
  }

  override browser(): BidiBrowser {
    return this.browserContext().browser();
  }

  override browserContext(): BidiBrowserContext {
    return this.#frame.browserContext;
  }

  override mainFrame(): BidiFrame {
    return this.#frame;
  }

  override frames(): BidiFrame[] {
    return [...this.#frame.getDescendants()];
  }

  override isClosed(): boolean {
    return this.#frame.disposed;
  }

  override async setUserAgent(
    userAgent: string,
    userAgentMetadata?: Protocol.Emulation.UserAgentMetadata | undefined
  ): Promise<void> {
    // TODO: handle CDP-specific cases such as mprach.
    await this._client().send('Network.setUserAgentOverride', {
      userAgent: userAgent,
      userAgentMetadata: userAgentMetadata,
    });
  }

  override async close(options?: {runBeforeUnload?: boolean}): Promise<void> {
    await this.#frame.close(options);
  }

  override async setBypassCSP(enabled: boolean): Promise<void> {
    // TODO: handle CDP-specific cases such as mprach.
    await this._client().send('Page.setBypassCSP', {enabled});
  }

  override async queryObjects<Prototype>(
    prototypeHandle: BidiJSHandle<Prototype>
  ): Promise<BidiJSHandle<Prototype[]>> {
    assert(!prototypeHandle.disposed, 'Prototype JSHandle is disposed!');
    assert(
      prototypeHandle.id,
      'Prototype JSHandle must not be referencing primitive value'
    );
    const response = await this.#frame.client.send('Runtime.queryObjects', {
      prototypeObjectId: prototypeHandle.id,
    });
    return createBidiHandle(this.#frame.mainRealm(), {
      type: 'array',
      handle: response.objects.objectId,
    }) as BidiJSHandle<Prototype[]>;
  }

  override async reload(
    options: WaitForOptions = {}
  ): Promise<BidiHTTPResponse | null> {
    return await this.#frame.reload(options);
  }

  override setDefaultNavigationTimeout(timeout: number): void {
    this._timeoutSettings.setDefaultNavigationTimeout(timeout);
  }

  override setDefaultTimeout(timeout: number): void {
    this._timeoutSettings.setDefaultTimeout(timeout);
  }

  override getDefaultTimeout(): number {
    return this._timeoutSettings.timeout();
  }

  override isJavaScriptEnabled(): boolean {
    return this.#cdpEmulationManager.javascriptEnabled;
  }

  override async setGeolocation(options: GeolocationOptions): Promise<void> {
    return await this.#cdpEmulationManager.setGeolocation(options);
  }

  override async setJavaScriptEnabled(enabled: boolean): Promise<void> {
    return await this.#cdpEmulationManager.setJavaScriptEnabled(enabled);
  }

  override async emulateMediaType(type?: string): Promise<void> {
    return await this.#cdpEmulationManager.emulateMediaType(type);
  }

  override async emulateCPUThrottling(factor: number | null): Promise<void> {
    return await this.#cdpEmulationManager.emulateCPUThrottling(factor);
  }

  override async emulateMediaFeatures(
    features?: MediaFeature[]
  ): Promise<void> {
    return await this.#cdpEmulationManager.emulateMediaFeatures(features);
  }

  override async emulateTimezone(timezoneId?: string): Promise<void> {
    return await this.#cdpEmulationManager.emulateTimezone(timezoneId);
  }

  override async emulateIdleState(overrides?: {
    isUserActive: boolean;
    isScreenUnlocked: boolean;
  }): Promise<void> {
    return await this.#cdpEmulationManager.emulateIdleState(overrides);
  }

  override async emulateVisionDeficiency(
    type?: Protocol.Emulation.SetEmulatedVisionDeficiencyRequest['type']
  ): Promise<void> {
    return await this.#cdpEmulationManager.emulateVisionDeficiency(type);
  }

  override async setViewport(viewport: Viewport): Promise<void> {
    if (!this.browser().cdpSupported) {
      await this.#emulationManager.emulateViewport(viewport);
      this.#viewport = viewport;
      return;
    }
    const needsReload =
      await this.#cdpEmulationManager.emulateViewport(viewport);
    this.#viewport = viewport;
    if (needsReload) {
      await this.reload();
    }
  }

  override viewport(): Viewport | null {
    return this.#viewport;
  }

  override async pdf(options?: PDFOptions): Promise<Buffer> {
    return await this.#frame.pdf(options);
  }

  override async createPDFStream(
    options?: PDFOptions | undefined
  ): Promise<Readable> {
    const buffer = await this.pdf(options);
    try {
      const {Readable} = await import('stream');
      return Readable.from(buffer);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(
          'Can only pass a file path in a Node-like environment.'
        );
      }
      throw error;
    }
  }

  override async _screenshot(
    options: Readonly<ScreenshotOptions>
  ): Promise<string> {
    return await this.#frame.screenshot(options);
  }

  override async waitForRequest(
    urlOrPredicate: string | AwaitablePredicate<HTTPRequest>,
    options?: WaitTimeoutOptions
  ): Promise<HTTPRequest> {
    return await this.#frame.waitForRequest(urlOrPredicate, options);
  }

  override async waitForResponse(
    urlOrPredicate: string | AwaitablePredicate<HTTPResponse>,
    options?: WaitTimeoutOptions
  ): Promise<HTTPResponse> {
    return await this.#frame.waitForResponse(urlOrPredicate, options);
  }

  override async waitForNetworkIdle(options?: {
    idleTime?: number;
    timeout?: number;
  }): Promise<void> {
    return await this.#frame.waitForNetworkIdle(options);
  }

  override async createCDPSession(): Promise<CDPSession> {
    return await this.#frame.createCDPSession();
  }

  override async bringToFront(): Promise<void> {
    await this.#frame.bringToFront();
  }

  override async evaluateOnNewDocument<
    Params extends unknown[],
    Func extends (...args: Params) => unknown = (...args: Params) => unknown,
  >(
    pageFunction: Func | string,
    ...args: Params
  ): Promise<NewDocumentScriptEvaluation> {
    const expression = evaluationExpression(pageFunction, ...args);
    const {result} = await this.#connection.send('script.addPreloadScript', {
      functionDeclaration: expression,
      contexts: [this.#frame._id],
    });

    return {identifier: result.script};
  }

  override async removeScriptToEvaluateOnNewDocument(
    id: string
  ): Promise<void> {
    await this.#connection.send('script.removePreloadScript', {
      script: id,
    });
  }

  override async exposeFunction<Args extends unknown[], Ret>(
    name: string,
    pptrFunction:
      | ((...args: Args) => Awaitable<Ret>)
      | {default: (...args: Args) => Awaitable<Ret>}
  ): Promise<void> {
    return await this.#frame.exposeFunction(
      name,
      'default' in pptrFunction ? pptrFunction.default : pptrFunction
    );
  }

  override isDragInterceptionEnabled(): boolean {
    return false;
  }

  override async setCacheEnabled(enabled?: boolean): Promise<void> {
    // TODO: handle CDP-specific cases such as mprach.
    await this._client().send('Network.setCacheDisabled', {
      cacheDisabled: !enabled,
    });
  }

  override isServiceWorkerBypassed(): never {
    throw new UnsupportedOperation();
  }

  override target(): BiDiPageTarget {
    throw new UnsupportedOperation();
  }

  override waitForFileChooser(): never {
    throw new UnsupportedOperation();
  }

  override workers(): never {
    throw new UnsupportedOperation();
  }

  override setRequestInterception(): never {
    throw new UnsupportedOperation();
  }

  override setDragInterception(): never {
    throw new UnsupportedOperation();
  }

  override setBypassServiceWorker(): never {
    throw new UnsupportedOperation();
  }

  override setOfflineMode(): never {
    throw new UnsupportedOperation();
  }

  override emulateNetworkConditions(): never {
    throw new UnsupportedOperation();
  }

  override cookies(): never {
    throw new UnsupportedOperation();
  }

  override setCookie(): never {
    throw new UnsupportedOperation();
  }

  override deleteCookie(): never {
    throw new UnsupportedOperation();
  }

  override removeExposedFunction(): never {
    // TODO: Quick win?
    throw new UnsupportedOperation();
  }

  override authenticate(): never {
    throw new UnsupportedOperation();
  }

  override setExtraHTTPHeaders(): never {
    throw new UnsupportedOperation();
  }

  override metrics(): never {
    throw new UnsupportedOperation();
  }

  override async goBack(
    options?: WaitForOptions
  ): Promise<HTTPResponse | null> {
    return await this.#go(-1, options);
  }

  override async goForward(
    options?: WaitForOptions
  ): Promise<HTTPResponse | null> {
    return await this.#go(+1, options);
  }

  async #go(
    delta: number,
    options?: WaitForOptions
  ): Promise<HTTPResponse | null> {
    try {
      const result = await Promise.all([
        this.waitForNavigation(options),
        this.#frame.context().traverseHistory(delta),
      ]);
      return result[0];
    } catch (err) {
      // TODO: waitForNavigation should be cancelled if an error happens.
      if (isErrorLike(err)) {
        if (err.message.includes('no such history entry')) {
          return null;
        }
      }
      throw err;
    }
  }

  override waitForDevicePrompt(): never {
    throw new UnsupportedOperation();
  }
}

function evaluationExpression(fun: Function | string, ...args: unknown[]) {
  return `() => {${evaluationString(fun, ...args)}}`;
}
