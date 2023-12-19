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

import * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {BrowserContext} from '../api/BrowserContext.js';
import {PageEvent, type Page} from '../api/Page.js';
import type {Target} from '../api/Target.js';
import {UnsupportedOperation} from '../common/Errors.js';
import {EventSubscription} from '../common/EventEmitter.js';
import type {Viewport} from '../common/Viewport.js';
import {Deferred} from '../util/Deferred.js';
import {DisposableStack} from '../util/disposable.js';

import type {BidiBrowser} from './Browser.js';
import {BrowsingContext} from './BrowsingContext.js';
import type {BidiConnection} from './Connection.js';
import {BidiPage} from './Page.js';

/**
 * @internal
 */
export interface BidiBrowserContextOptions {
  defaultViewport: Viewport | null;
  isDefault: boolean;
}

/**
 * @internal
 */
export class BidiBrowserContext extends BrowserContext {
  readonly #browser: BidiBrowser;
  readonly #defaultViewport: Viewport | null;
  readonly #isDefault: boolean;

  readonly #disposables = new DisposableStack();
  readonly #pages = new Map<string, Deferred<BidiPage>>();

  constructor(browser: BidiBrowser, options: BidiBrowserContextOptions) {
    super();
    this.#browser = browser;
    this.#defaultViewport = options.defaultViewport;
    this.#isDefault = options.isDefault;

    this.#disposables.use(
      new EventSubscription(
        this.#connection,
        'browsingContext.contextCreated',
        (info: Bidi.BrowsingContext.Info) => {
          if (info.parent) {
            return;
          }
          const page = new BidiPage(
            BrowsingContext.createTopContext(this, info.context, info.url)
          );
          const pageId = page.mainFrame()._id;

          const deferred = this.#pages.get(pageId) ?? new Deferred();
          deferred.resolve(page);
          this.#pages.set(pageId, deferred);

          this.#disposables.use(
            new EventSubscription(page, PageEvent.Close, (_: undefined) => {
              this.#pages.delete(pageId);
            })
          );
        }
      )
    );
  }

  get #connection(): BidiConnection {
    return this.#browser.connection;
  }

  override browser(): BidiBrowser {
    return this.#browser;
  }

  override async newPage(): Promise<Page> {
    const {
      result: {context},
    } = await this.#connection.send('browsingContext.create', {
      type: Bidi.BrowsingContext.CreateType.Tab,
    });
    const deferred = this.#pages.get(context) ?? new Deferred();
    this.#pages.set(context, deferred);

    const page = await deferred.valueOrThrow();
    if (this.#defaultViewport) {
      try {
        await page.setViewport(this.#defaultViewport);
      } catch {
        // No support for setViewport in Firefox.
      }
    }

    return page;
  }

  override async close(): Promise<void> {
    if (this.#isDefault) {
      throw new Error('Default context cannot be closed!');
    }
    const pages = await this.pages();
    await Promise.all(
      pages.map(async t => {
        await t.close();
      })
    );
  }

  override async pages(): Promise<BidiPage[]> {
    return await Promise.all(
      [...this.#pages.values()].map(t => {
        return t.valueOrThrow();
      })
    );
  }

  override isIncognito(): boolean {
    return !this.#isDefault;
  }

  override targets(): Target[] {
    throw new UnsupportedOperation();
  }
  override waitForTarget(): Promise<Target> {
    throw new UnsupportedOperation();
  }

  override overridePermissions(): never {
    throw new UnsupportedOperation();
  }

  override clearPermissionOverrides(): never {
    throw new UnsupportedOperation();
  }
}
