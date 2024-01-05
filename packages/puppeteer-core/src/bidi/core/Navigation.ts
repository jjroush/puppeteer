import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {EventEmitter, EventSubscription} from '../../common/EventEmitter.js';
import {Deferred} from '../../util/Deferred.js';
import {DisposableStack} from '../../util/disposable.js';

import type {BrowsingContext} from './BrowsingContext.js';
import type {BidiRequest} from './Request.js';

/**
 * @internal
 */
export interface NavigationInfo {
  url: string;
  timestamp: Date;
}

/**
 * @internal
 */

export class Navigation extends EventEmitter<{
  dom: NavigationInfo;
  loaded: NavigationInfo;
  failed: NavigationInfo;
  aborted: NavigationInfo;
}> {
  #context: BrowsingContext;
  #id = new Deferred<string>();
  #url: string;

  #disposables = new DisposableStack();

  constructor(context: BrowsingContext, url: string) {
    super();
    this.#context = context;
    this.#url = url;

    const connection = this.#context.context.browser.session.connection;
    for (const [bidiEvent, event] of [
      ['browsingContext.domContentLoaded', 'dom'],
      ['browsingContext.load', 'loaded'],
      ['browsingContext.navigationFailed', 'failed'],
      ['browsingContext.navigationAborted', 'aborted'],
    ] as const) {
      this.#disposables.use(
        new EventSubscription(
          connection,
          bidiEvent,
          (info: Bidi.BrowsingContext.NavigationInfo) => {
            if (info.context !== this.#context.id) {
              return;
            }
            if (!info.navigation) {
              return;
            }
            if (!this.#id.resolved()) {
              this.#id.resolve(info.navigation);
            }
            if (this.#id.value() !== info.navigation) {
              return;
            }
            this.#url = info.url;
            this.emit(event, {
              url: this.#url,
              timestamp: new Date(info.timestamp),
            });
          }
        )
      );
    }
  }

  get url(): string {
    return this.#url;
  }

  request(): BidiRequest | undefined {
    const id = this.#id.value() as string | undefined;
    for (const request of this.#context.requests) {
      if (request.navigation === id) {
        return request;
      }
    }
    return;
  }
}
