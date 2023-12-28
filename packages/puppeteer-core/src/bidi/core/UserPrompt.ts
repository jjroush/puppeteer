/**
 * Copyright 2017 Google Inc. All rights reserved.
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

import {EventEmitter, EventSubscription} from '../../common/EventEmitter.js';
import {DisposableStack} from '../../util/disposable.js';

import type {BrowsingContext} from './BrowsingContext.js';

export type HandleOptions = Omit<
  Bidi.BrowsingContext.HandleUserPromptParameters,
  'context'
>;

export type UserPromptResult = Omit<
  Bidi.BrowsingContext.UserPromptClosedParameters,
  'context'
>;

/**
 * @internal
 */
export class UserPrompt extends EventEmitter<{
  handled: UserPromptResult;
}> {
  context: BrowsingContext;
  #info: Bidi.BrowsingContext.UserPromptOpenedParameters;

  #result?: UserPromptResult;

  #disposables = new DisposableStack();

  constructor(
    context: BrowsingContext,
    info: Bidi.BrowsingContext.UserPromptOpenedParameters
  ) {
    super();
    this.context = context;
    this.#info = info;

    this.#disposables.use(
      new EventSubscription(
        this.context.context.browser.session.connection,
        'browsingContext.userPromptClosed',
        parameters => {
          if (parameters.context !== this.context.id) {
            return;
          }
          this.#result = parameters;
          this.#disposables.dispose();
          this.emit('handled', parameters);
          this.removeAllListeners();
        }
      )
    );
  }

  /**
   * @returns undefined if the {@link UserPrompt} was handled, either internally
   * or externally.
   */
  get result(): UserPromptResult | undefined {
    return this.#result;
  }

  async handle(options: HandleOptions = {}): Promise<UserPromptResult> {
    await this.context.context.browser.session.connection.send(
      'browsingContext.handleUserPrompt',
      {
        ...options,
        context: this.#info.context,
      }
    );
    return await new Promise(resolve => {
      return this.once('handled', resolve);
    });
  }
}
