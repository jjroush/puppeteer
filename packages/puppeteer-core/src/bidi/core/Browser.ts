import {EventEmitter} from '../../common/EventEmitter.js';
import {throwIfDisposed} from '../../util/decorators.js';

import type {Session} from './Session.js';

export class Browser extends EventEmitter<{
  // Emitted after the browser closes.
  closed: undefined;
  // Emitted after the browser disconnects. Supplied with the reason for
  // disconnection.
  disconnected: string;
}> {
  readonly session: Session;

  #reason: string | undefined;

  constructor(session: Session) {
    super();
    this.session = session;

    this.session.once('ended', () => {
      this.#reason = `Session (${this.session.id}) has already ended.`;
      this.emit('disconnected', this.#reason);
    });
  }

  get #connection() {
    return this.session.connection;
  }

  get disposed(): boolean {
    return !!this.#reason;
  }

  @throwIfDisposed((browser: Browser) => {
    return browser.#reason ?? '';
  })
  async close(): Promise<void> {
    await this.#connection.send('browser.close', {});
    this.#reason = `Browser has already closed.`;
    this.emit('closed', undefined);
    this.emit('disconnected', this.#reason);
  }
}
