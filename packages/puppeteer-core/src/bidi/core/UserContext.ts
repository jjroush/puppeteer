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
  context: BrowsingContext;
}> {
  readonly browser: Browser;

  readonly #disposables = new DisposableStack();
  readonly #contexts = new Map<string, Deferred<BrowsingContext>>();

  constructor(browser: Browser) {
    super();
    this.browser = browser;

    this.#disposables.use(
      new EventSubscription(
        this.#connection,
        'browsingContext.contextCreated',
        (info: Bidi.BrowsingContext.Info) => {
          if (info.parent) {
            return;
          }
          const context = BrowsingContext.create(this, info.context, info.url);

          const deferred = this.#contexts.get(context.id) ?? new Deferred();
          deferred.resolve(context);
          this.#contexts.set(context.id, deferred);

          this.emit('context', context);
        }
      )
    );
  }

  get #connection() {
    return this.browser.session.connection;
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

    const context = this.#contexts.get(contextId) ?? new Deferred();
    this.#contexts.set(contextId, context);

    return await context.valueOrThrow();
  }
}
