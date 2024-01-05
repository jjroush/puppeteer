import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {EventEmitter, EventSubscription} from '../../common/EventEmitter.js';
import {throwIfDisposed} from '../../util/decorators.js';
import {DisposableStack} from '../../util/disposable.js';

import {Navigation} from './Navigation.js';
import {BidiRequest} from './Request.js';
import type {UserContext} from './UserContext.js';
import {UserPrompt} from './UserPrompt.js';

export type CaptureScreenshotOptions = Omit<
  Bidi.BrowsingContext.CaptureScreenshotParameters,
  'context'
>;

export type ReloadOptions = Omit<
  Bidi.BrowsingContext.ReloadParameters,
  'context'
>;

export type PrintOptions = Omit<
  Bidi.BrowsingContext.PrintParameters,
  'context'
>;

export type HandleUserPromptOptions = Omit<
  Bidi.BrowsingContext.HandleUserPromptParameters,
  'context'
>;

/**
 * @internal
 */
export class BrowsingContext extends EventEmitter<{
  // Emitted when a child context is created.
  created: {context: BrowsingContext};
  // Emitted when a child context or itself is destroyed.
  destroyed: {context: BrowsingContext};
  // Emitted whenever a navigation occurs on itself.
  navigation: Navigation;
  // Emitted whenever a request is made.
  request: BidiRequest;
  // Emitted whenever the context logs something.
  log: Bidi.Log.Entry;
  // Emitted whenever a prompt is opened.
  userprompt: UserPrompt;
}> {
  static create(
    context: UserContext,
    id: string,
    url: string
  ): BrowsingContext {
    return new BrowsingContext(context, undefined, id, url);
  }

  readonly context: UserContext;
  readonly parent: BrowsingContext | undefined;
  readonly id: string;
  #url: string;

  readonly #disposables = new DisposableStack();
  readonly #children = new Map<string, BrowsingContext>();
  readonly #requests = new Map<string, BidiRequest>();

  #navigation?: Navigation;
  #userPrompt?: UserPrompt;

  private constructor(
    context: UserContext,
    parent: BrowsingContext | undefined,
    id: string,
    url: string
  ) {
    super();
    this.context = context;
    this.parent = parent;
    this.id = id;
    this.#url = url;

    const connection = this.#connection;
    this.#disposables.use(
      new EventSubscription(
        connection,
        'browsingContext.contextCreated',
        info => {
          if (info.parent !== this.id) {
            return;
          }
          const context = new BrowsingContext(
            this.context,
            this,
            info.context,
            info.url
          );
          this.#children.set(info.context, context);
          this.emit('created', {context: context});

          this.#disposables.use(
            new EventSubscription(
              context,
              'destroyed',
              ({context: destroyedContext}) => {
                if (destroyedContext !== context) {
                  return;
                }
                this.#children.delete(destroyedContext.id);
                this.emit('destroyed', {context: destroyedContext});
              }
            )
          );
        }
      )
    );
    this.#disposables.use(
      new EventSubscription(
        connection,
        'browsingContext.contextDestroyed',
        info => {
          if (info.context !== this.id) {
            return;
          }
          this.#disposables.dispose();
          this.emit('destroyed', {context: this});
          this.removeAllListeners();
        }
      )
    );

    this.#disposables.use(
      new EventSubscription(
        connection,
        'browsingContext.navigationStarted',
        info => {
          if (info.context !== this.id) {
            return;
          }
          this.#url = info.url;
          this.#requests.clear();
          // Note the navigation ID is null for this event.
          this.#navigation = new Navigation(this, info.url);
          this.emit('navigation', this.#navigation);
        }
      )
    );
    this.#disposables.use(
      new EventSubscription(connection, 'network.beforeRequestSent', event => {
        if (event.context !== this.id) {
          return;
        }
        if (this.#requests.has(event.request.request)) {
          return;
        }
        const request = new BidiRequest(this, event);
        this.#requests.set(request.id, request);
        this.emit('request', request);
      })
    );
    this.#disposables.use(
      new EventSubscription(connection, 'log.entryAdded', entry => {
        if (entry.source.context !== this.id) {
          return;
        }
        this.emit('log', entry);
      })
    );
    this.#disposables.use(
      new EventSubscription(
        connection,
        'browsingContext.userPromptOpened',
        info => {
          if (info.context !== this.id) {
            return;
          }
          const userPrompt = new UserPrompt(this, info);
          this.#userPrompt = userPrompt;
          this.emit('userprompt', this.#userPrompt);
        }
      )
    );
  }

  get #connection() {
    return this.context.browser.session.connection;
  }

  get disposed(): boolean {
    return this.#disposables.disposed;
  }

  get children(): Iterable<BrowsingContext> {
    return this.#children.values();
  }

  get top(): BrowsingContext {
    let context = this as BrowsingContext;
    for (let {parent} = context; parent; {parent} = context) {
      context = parent;
    }
    return context;
  }

  get url(): string {
    return this.#url;
  }

  get navigation(): Navigation | undefined {
    return this.#navigation;
  }

  get userPrompt(): UserPrompt | undefined {
    return this.#userPrompt;
  }

  get requests(): Iterable<BidiRequest> {
    return this.#requests.values();
  }

  @throwIfDisposed()
  async activate(): Promise<void> {
    await this.#connection.send('browsingContext.activate', {
      context: this.id,
    });
  }

  @throwIfDisposed()
  async captureScreenshot(
    options: CaptureScreenshotOptions = {}
  ): Promise<string> {
    const {
      result: {data},
    } = await this.#connection.send('browsingContext.captureScreenshot', {
      context: this.id,
      ...options,
    });
    return data;
  }

  @throwIfDisposed()
  async close(promptUnload?: boolean): Promise<void> {
    await Promise.all(
      [...this.#children.values()].map(async child => {
        await child.close(promptUnload);
      })
    );
    await this.#connection.send('browsingContext.close', {
      context: this.id,
      promptUnload,
    });
  }

  @throwIfDisposed()
  async traverseHistory(delta: number): Promise<void> {
    await this.#connection.send('browsingContext.traverseHistory', {
      context: this.id,
      delta,
    });
  }

  @throwIfDisposed()
  async navigate(
    url: string,
    wait?: Bidi.BrowsingContext.ReadinessState
  ): Promise<Navigation> {
    await this.#connection.send('browsingContext.navigate', {
      context: this.id,
      url,
      wait,
    });
    return await new Promise(resolve => {
      this.once('navigation', resolve);
    });
  }

  @throwIfDisposed()
  async reload(options: ReloadOptions = {}): Promise<Navigation> {
    await this.#connection.send('browsingContext.reload', {
      context: this.id,
      ...options,
    });
    return await new Promise(resolve => {
      this.once('navigation', resolve);
    });
  }

  @throwIfDisposed()
  async print(options: PrintOptions = {}): Promise<string> {
    const {
      result: {data},
    } = await this.#connection.send('browsingContext.print', {
      context: this.id,
      ...options,
    });
    return data;
  }

  @throwIfDisposed()
  async handleUserPrompt(options: HandleUserPromptOptions = {}): Promise<void> {
    await this.#connection.send('browsingContext.handleUserPrompt', {
      context: this.id,
      ...options,
    });
  }
}
