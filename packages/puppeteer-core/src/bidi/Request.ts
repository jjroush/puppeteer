import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {EventEmitter, EventSubscription} from '../common/EventEmitter.js';
import {DisposableStack} from '../util/disposable.js';

import type {BrowsingContext} from './BrowsingContext.js';
import type {Navigation} from './Navigation.js';

export class BidiRequest extends EventEmitter<{
  response: undefined;
  error: undefined;
}> {
  readonly #context: BrowsingContext;
  readonly #navigation: Navigation | undefined;
  readonly #event: Bidi.Network.BeforeRequestSentParameters;

  #disposables = new DisposableStack();

  constructor(
    context: BrowsingContext,
    navigation: Navigation | undefined,
    event: Bidi.Network.BeforeRequestSentParameters
  ) {
    super();
    this.#context = context;
    this.#navigation = navigation;
    this.#event = event;

    const connection = this.#context.browserContext.browser().connection;
    this.#disposables.use(
      new EventSubscription(
        connection,
        'network.responseCompleted',
        (event: Bidi.Network.ResponseCompletedParameters) => {
          if (
            event.context !== this.#context.id ||
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

  get id(): string {
    return this.#event.request.request;
  }
}
