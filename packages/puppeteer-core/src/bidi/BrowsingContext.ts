import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {EventEmitter, EventSubscription} from '../common/EventEmitter.js';
import {throwIfDisposed} from '../util/decorators.js';
import {DisposableStack} from '../util/disposable.js';

import {BidiCdpSession} from './BidiCdpSession.js';
import type {BidiBrowserContext} from './BrowserContext.js';
import type {BidiConnection} from './Connection.js';
import {Navigation} from './Navigation.js';
import {BidiRequest} from './Request.js';

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
  created: BrowsingContext;
  // Emitted when a child context or itself is destroyed.
  destroyed: BrowsingContext;
  // Emitted whenever the navigation occurs.
  navigation: Navigation;
  // Emitted whenever a request is made.
  request: BidiRequest;
}> {
  static createTopContext(
    browserContext: BidiBrowserContext,
    id: string,
    url: string
  ): BrowsingContext {
    return new BrowsingContext(browserContext, undefined, id, url);
  }

  readonly #browserContext: BidiBrowserContext;
  readonly #parent: BrowsingContext | undefined;
  readonly id: string;
  #url: string;

  readonly #disposables = new DisposableStack();
  readonly #children = new Map<string, BrowsingContext>();

  readonly #cdpSession: BidiCdpSession;

  // Only a single navigation can occur at a time.
  #navigation?: Navigation;

  // A map of ongoing requests.
  readonly #requests = new Map<string, BidiRequest>();

  private constructor(
    browserContext: BidiBrowserContext,
    parent: BrowsingContext | undefined,
    id: string,
    url: string
  ) {
    super();

    this.#browserContext = browserContext;
    this.#parent = parent;
    this.id = id;
    this.#url = url;

    this.#cdpSession = new BidiCdpSession(this);

    this.#disposables.use(
      new EventSubscription(
        this.#connection,
        'browsingContext.contextCreated',
        (info: Bidi.BrowsingContext.Info) => {
          if (info.parent !== this.id) {
            return;
          }
          const context = new BrowsingContext(
            this.#browserContext,
            this,
            info.context,
            info.url
          );
          this.#children.set(info.context, context);
          this.emit('created', context);

          this.#disposables.use(
            new EventSubscription(
              context,
              'destroyed',
              (destroyedContext: BrowsingContext) => {
                if (destroyedContext !== context) {
                  return;
                }
                this.#children.delete(context.id);
                this.emit('destroyed', context);
              }
            )
          );
        }
      )
    );

    this.#disposables.use(
      new EventSubscription(
        this.#connection,
        'browsingContext.contextDestroyed',
        (info: Bidi.BrowsingContext.Info) => {
          if (info.context !== this.id) {
            return;
          }
          this.#disposables.dispose();
          this.emit('destroyed', this);
          this.removeAllListeners();
        }
      )
    );

    this.#disposables.use(
      new EventSubscription(
        this.#connection,
        'browsingContext.navigationStarted',
        (info: Bidi.BrowsingContext.NavigationInfo) => {
          if (info.context !== this.id) {
            return;
          }
          this.#url = info.url;
          this.#navigation = new Navigation(this, info.navigation, info.url);
          this.emit('navigation', this.#navigation);
        }
      )
    );

    this.#disposables.use(
      new EventSubscription(
        this.#connection,
        'network.beforeRequestSent',
        (event: Bidi.Network.BeforeRequestSentParameters) => {
          if (event.context !== this.id) {
            return;
          }
          if (event.navigation) {
            return;
          }
          const request = new BidiRequest(this, undefined, event);
          this.#requests.set(request.id, request);
          this.emit('request', request);
        }
      )
    );
  }

  get disposed(): boolean {
    return this.#disposables.disposed;
  }

  get parent(): BrowsingContext | undefined {
    return this.#parent;
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

  get browserContext(): BidiBrowserContext {
    return this.#browserContext;
  }

  get cdpSession(): BidiCdpSession {
    return this.#cdpSession;
  }

  get #connection(): BidiConnection {
    return this.#browserContext.browser().connection;
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
