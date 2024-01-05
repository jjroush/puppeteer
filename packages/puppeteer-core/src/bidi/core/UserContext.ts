import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {EventEmitter, EventSubscription} from '../../common/EventEmitter.js';
import {Deferred} from '../../util/Deferred.js';
import {DisposableStack} from '../../util/disposable.js';

import type {Browser} from './Browser.js';
import {BrowsingContext} from './BrowsingContext.js';

export type CreateBrowsingContextOptions = Omit<
  Bidi.BrowsingContext.CreateParameters,
  'type' | 'referenceContext'
> & {
  referenceContext?: BrowsingContext;
};

export class UserContext extends EventEmitter<{
  /**
   * Emitted when a new browsing context is created.
   */
  context: {context: BrowsingContext};
}> {
  static create(browser: Browser, id: string): UserContext {
    const context = new UserContext(browser, id);
    void context.#initialize();
    return context;
  }

  readonly browser: Browser;
  readonly id: string;

  readonly #disposables = new DisposableStack();
  // Note these are only top-level contexts.
  readonly #contexts = new Map<string, Deferred<BrowsingContext>>();

  constructor(browser: Browser, id: string) {
    super();
    this.id = id;
    this.browser = browser;
  }

  get #connection() {
    return this.browser.session.connection;
  }

  get contexts(): AsyncIterable<BrowsingContext> {
    return async function* (this: UserContext) {
      for (const context of this.#contexts.values()) {
        yield await context.valueOrThrow();
      }
    }.call(this);
  }

  async #initialize() {
    const connection = this.#connection;
    this.#disposables.use(
      new EventSubscription(
        connection,
        'browsingContext.contextCreated',
        (info: Bidi.BrowsingContext.Info) => {
          if (info.parent) {
            return;
          }
          const context = BrowsingContext.create(this, info.context, info.url);

          const deferred = this.#contexts.get(context.id) ?? new Deferred();
          deferred.resolve(context);
          this.#contexts.set(context.id, deferred);
          this.emit('context', {context});
        }
      )
    );
  }

  async createBrowsingContext(
    type: Bidi.BrowsingContext.CreateType,
    options: CreateBrowsingContextOptions = {}
  ): Promise<BrowsingContext> {
    const {
      result: {context: contextId},
    } = await this.#connection.send('browsingContext.create', {
      type,
      ...options,
      referenceContext: options.referenceContext?.id,
    });

    const deferred = this.#contexts.get(contextId) ?? new Deferred();
    this.#contexts.set(contextId, deferred);

    return await deferred.valueOrThrow();
  }

  async close(): Promise<void> {
    for (const deferred of this.#contexts.values()) {
      const context = await deferred.valueOrThrow();
      await context.close();
    }
  }
}
