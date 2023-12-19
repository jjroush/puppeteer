import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {EventEmitter, EventSubscription} from '../common/EventEmitter.js';
import {DisposableStack} from '../util/disposable.js';

import type {BrowsingContext} from './BrowsingContext.js';
import {BidiRequest} from './Request.js';

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
  #id: string | null;
  #url: string;

  #disposables = new DisposableStack();
  #request?: BidiRequest;

  constructor(context: BrowsingContext, id: string | null, url: string) {
    super();
    this.#context = context;
    this.#id = id;
    this.#url = url;

    const connection = this.#context.browserContext.browser().connection;
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
            if (
              info.context !== this.#context.id ||
              info.navigation !== this.#id
            ) {
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

    this.#disposables.use(
      new EventSubscription(
        connection,
        'network.beforeRequestSent',
        (event: Bidi.Network.BeforeRequestSentParameters) => {
          if (event.context !== this.#context.id) {
            return;
          }
          if (event.navigation !== this.#id) {
            return;
          }
          this.#request = new BidiRequest(this.#context, this, event);
        }
      )
    );
  }

  get url(): string {
    return this.#url;
  }

  get request(): BidiRequest | undefined {
    return this.#request;
  }
}
