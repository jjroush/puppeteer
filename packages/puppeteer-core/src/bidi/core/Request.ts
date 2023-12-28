import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {EventEmitter, EventSubscription} from '../../common/EventEmitter.js';
import {DisposableStack} from '../../util/disposable.js';

import type {BrowsingContext} from './BrowsingContext.js';

export class BidiRequest extends EventEmitter<{
  // Emitted whenever the request is redirected.
  redirect: BidiRequest;
  // Emitted when when the request succeeds.
  success: Bidi.Network.ResponseData;
  // Emitted when when the request errors.
  error: string;
}> {
  readonly #context: BrowsingContext;
  readonly #event: Bidi.Network.BeforeRequestSentParameters;

  readonly #response?: Bidi.Network.ResponseData;
  readonly #disposables = new DisposableStack();

  #redirect?: BidiRequest;

  constructor(
    context: BrowsingContext,
    event: Bidi.Network.BeforeRequestSentParameters
  ) {
    super();
    this.#context = context;
    this.#event = event;

    const connection = this.#context.context.browser.session.connection;
    this.#disposables.use(
      new EventSubscription(connection, 'network.responseCompleted', event => {
        if (event.context !== this.#context.id) {
          return;
        }
        if (event.request.request !== this.id) {
          return;
        }
        this.emit('success', event.response);
      })
    );
    this.#disposables.use(
      new EventSubscription(connection, 'network.fetchError', event => {
        if (event.context !== this.#context.id) {
          return;
        }
        if (event.request.request !== this.id) {
          return;
        }
        this.emit('error', event.errorText);
      })
    );
    this.#disposables.use(
      new EventSubscription(connection, 'network.beforeRequestSent', event => {
        if (event.context !== this.id) {
          return;
        }
        if (event.request.request !== this.id) {
          return;
        }
        if (this.#redirect) {
          return;
        }
        this.#redirect = new BidiRequest(this.#context, event);
        this.emit('redirect', this.#redirect);
      })
    );
  }

  get id(): string {
    return this.#event.request.request;
  }

  get url(): string {
    return this.#event.request.url;
  }

  get initiator(): Bidi.Network.Initiator {
    return this.#event.initiator;
  }

  get method(): string {
    return this.#event.request.method;
  }

  get headers(): Bidi.Network.Header[] {
    return this.#event.request.headers;
  }

  get navigation(): string | undefined {
    return this.#event.navigation ?? undefined;
  }

  get redirect(): BidiRequest | undefined {
    return this.redirect;
  }

  get response(): Bidi.Network.ResponseData | undefined {
    return this.#response;
  }
}
