import {EventEmitter} from '../../common/EventEmitter.js';
import {throwIfDisposed} from '../../util/decorators.js';

import type {Session} from './Session.js';
import {UserContext} from './UserContext.js';

export class Browser extends EventEmitter<{
  /**
   * Emitted after the browser closes.
   */
  closed: {reason: string};
  /**
   * Emitted after the browser disconnects.
   */
  disconnected: {reason: string};
}> {
  static create(session: Session): Browser {
    const browser = new Browser(session);
    void browser.#initialize();
    return browser;
  }

  readonly session: Session;
  readonly contexts = new Map([['', UserContext.create(this, '')]]);

  #reason: string | undefined;

  private constructor(session: Session) {
    super();
    this.session = session;
  }

  get #connection() {
    return this.session.connection;
  }

  get disposed(): boolean {
    return this.#reason !== undefined;
  }

  get defaultContext(): UserContext {
    // SAFETY: A UserContext is always created for the default context.
    return this.contexts.get('')!;
  }

  async #initialize() {
    this.session.once('ended', ({reason}) => {
      this.#reason = reason;
      this.emit('disconnected', {reason});
      this.removeAllListeners();
    });

    const connection = this.#connection;
    const {
      result: {contexts},
    } = await connection.send('browsingContext.getTree', {});

    // Simulating events so contexts are created naturally.
    for (const context of contexts) {
      connection.emit('browsingContext.contextCreated', context);
      if (context.children) {
        contexts.push(...context.children);
      }
    }
  }

  @throwIfDisposed((browser: Browser) => {
    // SAFETY: By definition of `disposed`, `#reason` is defined.
    return browser.#reason!;
  })
  async close(): Promise<void> {
    await this.#connection.send('browser.close', {});
    this.#reason = `Browser has already closed.`;
    this.emit('closed', {reason: this.#reason});
    this.removeAllListeners();
  }
}
