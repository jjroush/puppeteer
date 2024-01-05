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

import type {ChildProcess} from 'child_process';

import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {
  Browser,
  BrowserEvent,
  type BrowserCloseCallback,
  type BrowserContextOptions,
} from '../api/Browser.js';
import type {Page} from '../api/Page.js';
import type {Target} from '../api/Target.js';
import {UnsupportedOperation} from '../common/Errors.js';
import type {Viewport} from '../common/Viewport.js';

import {BidiBrowserContext} from './BrowserContext.js';
import type {Browser as BrowserCore} from './core/Browser.js';
import type {Connection} from './core/Connection.js';
import {Session} from './core/Session.js';

/**
 * @internal
 */
export interface BidiBrowserOptions {
  closeCallback?: BrowserCloseCallback;
  defaultViewport?: Viewport;
  process?: ChildProcess;
  ignoreHTTPSErrors?: boolean;
}

/**
 * @internal
 */
export class BidiBrowser extends Browser {
  readonly protocol = 'webDriverBiDi';

  // TODO: Update generator to include fully module
  static readonly subscribeModules: string[] = [
    'browsingContext',
    'network',
    'log',
    'script',
  ];
  static readonly subscribeCdpEvents: Bidi.Cdp.EventNames[] = [
    // Coverage
    'cdp.Debugger.scriptParsed',
    'cdp.CSS.styleSheetAdded',
    'cdp.Runtime.executionContextsCleared',
    // Tracing
    'cdp.Tracing.tracingComplete',
    // TODO: subscribe to all CDP events in the future.
    'cdp.Network.requestWillBeSent',
    'cdp.Debugger.scriptParsed',
    'cdp.Page.screencastFrame',
  ];

  static async create(
    connection: Connection,
    options: BidiBrowserOptions
  ): Promise<BidiBrowser> {
    const {ignoreHTTPSErrors} = options;

    const session = await Session.create(connection, {
      alwaysMatch: {
        acceptInsecureCerts: ignoreHTTPSErrors,
        webSocketUrl: true,
      },
    });

    const browser = new BidiBrowser(session);
    await browser.#initialize();
    return browser;
  }

  #session: Session;
  #process?: ChildProcess;
  #closeCallback?: BrowserCloseCallback;
  #defaultViewport?: Viewport;

  constructor(
    session: Session,
    closeCallback?: BrowserCloseCallback,
    defaultViewport?: Viewport,
    process?: ChildProcess
  ) {
    super();
    this.#session = session;
    this.#process = process;
    this.#closeCallback = closeCallback;
    this.#defaultViewport = defaultViewport;
  }

  get #browser(): BrowserCore {
    return this.#session.browser;
  }

  get #browserName(): string {
    return this.#session.capabilities.browserName;
  }

  get #browserVersion(): string {
    return this.#session.capabilities.browserVersion;
  }

  get cdpSupported(): boolean {
    return !this.#browserName.toLowerCase().includes('firefox');
  }

  async #initialize(): Promise<void> {
    this.#browser.once('closed', () => {
      void this.#closeCallback?.call(null);
    });
    this.#browser.once('disconnected', () => {
      this.emit(BrowserEvent.Disconnected, undefined);
      this.removeAllListeners();
    });
  }

  override userAgent(): never {
    throw new UnsupportedOperation();
  }

  override wsEndpoint(): string {
    // SAFETY: `webSocketUrl` is true in `Session.create`.
    return this.#session.capabilities.webSocketUrl as string;
  }

  override async close(): Promise<void> {
    await this.#session.browser.close();
  }

  override get connected(): boolean {
    return !this.#browser.disposed;
  }

  override process(): ChildProcess | null {
    return this.#process ?? null;
  }

  override async createIncognitoBrowserContext(
    _options?: BrowserContextOptions
  ): Promise<BidiBrowserContext> {
    // TODO: implement incognito context https://github.com/w3c/webdriver-bidi/issues/289.
    await new Promise(resolve => {
      return setTimeout(resolve, 0);
    });
    return this.defaultBrowserContext();
  }

  override async version(): Promise<string> {
    return `${this.#browserName}/${this.#browserVersion}`;
  }

  override browserContexts(): BidiBrowserContext[] {
    // TODO: implement incognito context https://github.com/w3c/webdriver-bidi/issues/289.
    return [this.defaultBrowserContext()];
  }

  override defaultBrowserContext(): BidiBrowserContext {
    return BidiBrowserContext.create(
      this,
      this.#session.browser.defaultContext,
      {defaultViewport: this.#defaultViewport ?? null}
    );
  }

  override async newPage(): Promise<Page> {
    return await this.defaultBrowserContext().newPage();
  }

  override targets(): Target[] {
    throw new UnsupportedOperation('Not implemented');
  }

  override target(): Target {
    throw new UnsupportedOperation('Not implemented');
  }

  override async disconnect(): Promise<void> {
    await this.#session.end();
  }
}
