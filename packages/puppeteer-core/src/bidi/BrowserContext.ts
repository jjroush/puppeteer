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
import type {Page} from '../api/Page.js';
import type {Target} from '../api/Target.js';
import {UnsupportedOperation} from '../common/Errors.js';
import type {Viewport} from '../common/Viewport.js';
import {cached} from '../util/decorators.js';

import type {BidiBrowser} from './Browser.js';
import type {UserContext} from './core/UserContext.js';
import {BidiPage} from './Page.js';

/**
 * @internal
 */
export interface BidiBrowserContextOptions {
  defaultViewport: Viewport | null;
}

/**
 * @internal
 */
export class BidiBrowserContext extends BrowserContext {
  @cached((_, context, __) => {
    return context;
  })
  static create(
    browser: BidiBrowser,
    userContext: UserContext,
    options: BidiBrowserContextOptions
  ): BidiBrowserContext {
    const context = new BidiBrowserContext(browser, userContext, options);
    void context.#initialize();
    return context;
  }

  readonly #browser: BidiBrowser;
  readonly #context: UserContext;
  readonly #defaultViewport: Viewport | null;

  private constructor(
    browser: BidiBrowser,
    context: UserContext,
    options: BidiBrowserContextOptions
  ) {
    super();
    this.#browser = browser;
    this.#context = context;
    this.#defaultViewport = options.defaultViewport;
  }

  async #initialize(): Promise<void> {}

  override browser(): BidiBrowser {
    return this.#browser;
  }

  override async newPage(): Promise<Page> {
    const context = await this.#context.createBrowsingContext(
      Bidi.BrowsingContext.CreateType.Tab
    );

    const page = await BidiPage.create(context);
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
    if (this.#context.id === '') {
      throw new Error('Default context cannot be closed!');
    }
    await this.#context.close();
  }

  override async pages(): Promise<BidiPage[]> {
    const pages = [];
    for await (const context of this.#context.contexts) {
      pages.push(BidiPage.create(context));
    }
    return await Promise.all(pages);
  }

  override isIncognito(): boolean {
    // TODO: implement incognito context https://github.com/w3c/webdriver-bidi/issues/289.
    return false;
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
