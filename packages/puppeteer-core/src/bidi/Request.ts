import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {Deferred} from '../util/Deferred.js';

import type {BrowsingContext} from './BrowsingContext.js';

export class BidiRequest {
  readonly #context: BrowsingContext;
  readonly #event: Bidi.Network.BeforeRequestSentParameters;
  readonly #response = new Deferred<Bidi.Network.ResponseData>();

  constructor(
    context: BrowsingContext,
    event: Bidi.Network.BeforeRequestSentParameters
  ) {
    this.#context = context;
    this.#event = event;

    const connection = this.#context.browserContext.browser().connection;
    connection.onceIf(
      'network.responseCompleted',
      event => {
        return event.request.request === this.id;
      },
      event => {
        this.#response.resolve(event.response);
      }
    );
    connection.onceIf(
      'network.fetchError',
      event => {
        return event.request.request === this.id;
      },
      event => {
        this.#response.reject(new Error(event.errorText));
      }
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

  response(): Deferred<Bidi.Network.ResponseData> {
    return this.#response;
  }
}
