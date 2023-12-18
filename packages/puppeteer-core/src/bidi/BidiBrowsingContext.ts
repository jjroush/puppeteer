import * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';
import {EventEmitter, EventSubscription} from '../common/EventEmitter.js';
import {DisposableStack} from '../util/disposable.js';
import {BidiBrowserContext} from './BrowserContext.js';
import {BidiConnection} from './Connection.js';
import {throwIfDisposed} from '../util/decorators.js';

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
export class BrowsingContext {
  #browserContext: BidiBrowserContext;
  #info: Bidi.BrowsingContext.Info;

  // Only a single navigation can occur at a time.
  #navigation?: Navigation;

  constructor(
    browserContext: BidiBrowserContext,
    info: Bidi.BrowsingContext.Info
  ) {
    this.#browserContext = browserContext;
    this.#info = info;
  }

  get parent(): BrowsingContext | undefined {
    return this.#info.parent
      ? this.#browserContext.getBrowsingContext(this.#info.parent)
      : undefined;
  }

  get top(): BrowsingContext {
    let context = this as BrowsingContext;
    for (let {parent} = context; parent; {parent} = context) {
      context = parent;
    }
    return context;
  }

  get id(): string {
    return this.#info.context;
  }

  get url(): string {
    return this.#info.url;
  }

  get browserContext(): BidiBrowserContext {
    return this.#browserContext;
  }

  get #connection(): BidiConnection {
    return this.#browserContext.browser().connection;
  }

  @throwIfDisposed()
  async activate(): Promise<void> {
    await this.#connection.send('browsingContext.activate', {
      context: this.#info.context,
    });
  }

  @throwIfDisposed()
  async captureScreenshot(
    options: CaptureScreenshotOptions = {}
  ): Promise<string> {
    const {
      result: {data},
    } = await this.#connection.send('browsingContext.captureScreenshot', {
      context: this.#info.context,
      ...options,
    });
    return data;
  }

  @throwIfDisposed()
  async close(promptUnload?: boolean): Promise<void> {
    await this.#connection.send('browsingContext.close', {
      context: this.#info.context,
      promptUnload,
    });
  }

  @throwIfDisposed()
  async traverseHistory(delta: number): Promise<void> {
    await this.#connection.send('browsingContext.traverseHistory', {
      context: this.#info.context,
      delta,
    });
  }

  @throwIfDisposed()
  async navigate(
    url: string,
    wait?: Bidi.BrowsingContext.ReadinessState
  ): Promise<Navigation> {
    this.#navigation?.dispose();
    const {result} = await this.#connection.send('browsingContext.navigate', {
      context: this.#info.context,
      url,
      wait,
    });
    const navigation = new Navigation(this, result.navigation, result.url);
    navigation.initialize();
    navigation.on('*', () => {
      this.#info.url = navigation.url;
    });
    return (this.#navigation = navigation);
  }

  @throwIfDisposed()
  async reload(options: ReloadOptions = {}): Promise<Navigation> {
    this.#navigation?.dispose();
    const {result} = await this.#connection.send('browsingContext.reload', {
      context: this.#info.context,
      ...options,
    });
    const navigation = new Navigation(this, result.navigation, result.url);
    navigation.initialize();
    navigation.on('*', () => {
      this.#info.url = navigation.url;
    });
    return (this.#navigation = navigation);
  }

  @throwIfDisposed()
  async print(options: PrintOptions = {}): Promise<string> {
    const {
      result: {data},
    } = await this.#connection.send('browsingContext.print', {
      context: this.#info.context,
      ...options,
    });
    return data;
  }

  @throwIfDisposed()
  async handleUserPrompt(options: HandleUserPromptOptions = {}): Promise<void> {
    await this.#connection.send('browsingContext.handleUserPrompt', {
      context: this.#info.context,
      ...options,
    });
  }

  #disposed = false;
  get disposed(): boolean {
    return this.#disposed;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#navigation?.dispose();
  }
}

/**
 * @internal
 */
export class Navigation extends EventEmitter<{
  started: Date;
  domLoaded: Date;
  loaded: Date;
  failed: Date;
  aborted: Date;
}> {
  #context: BrowsingContext;
  #id: string | null;
  #url: string;

  #disposables = new DisposableStack();

  constructor(context: BrowsingContext, id: string | null, url: string) {
    super();
    this.#context = context;
    this.#id = id;
    this.#url = url;
  }

  initialize(): void {
    for (const [bidiEvent, eventName] of [
      ['browsingContext.navigationStarted', 'started'],
      ['browsingContext.domContentLoaded', 'domLoaded'],
      ['browsingContext.load', 'loaded'],
      ['browsingContext.navigationFailed', 'failed'],
      ['browsingContext.navigationAborted', 'aborted'],
    ] as const) {
      this.#disposables.use(
        new EventSubscription(
          this.#context.browserContext.connection,
          bidiEvent,
          (info: Bidi.BrowsingContext.NavigationInfo) => {
            if (
              info.context !== this.#context.id ||
              info.navigation !== this.#id
            ) {
              return;
            }
            this.#url = info.url;
            this.emit(eventName, new Date(info.timestamp));
          }
        )
      );
    }
  }

  dispose(): void {
    this.#disposables.dispose();
  }

  get url(): string {
    return this.#url;
  }

  async waitUntil(
    event: 'started' | 'domLoaded' | 'loaded' | 'failed' | 'aborted'
  ): Promise<Date> {
    return await new Promise(resolve => {
      this.once(event, resolve);
    });
  }
}
