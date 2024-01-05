import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {EventEmitter} from '../../common/EventEmitter.js';
import {throwIfDisposed} from '../../util/decorators.js';

import {Browser} from './Browser.js';
import type {Connection} from './Connection.js';

export class Session extends EventEmitter<{
  /**
   * Emitted when the session has ended.
   */
  ended: {reason: string};
}> {
  static async create(
    connection: Connection,
    capabilities: Bidi.Session.CapabilitiesRequest
  ): Promise<Session> {
    // Wait until the connection is ready.
    while (true) {
      const {result: ready} = await connection.send('session.status', {});
      if (ready) {
        break;
      }
    }

    const {result} = await connection.send('session.new', {
      capabilities,
    });
    const session = new Session(connection, result);
    await session.#initialize();
    return session;
  }

  readonly connection: Connection;
  readonly browser = Browser.create(this);

  readonly #info: Bidi.Session.NewResult;

  #reason: string | undefined;

  constructor(connection: Connection, info: Bidi.Session.NewResult) {
    super();
    this.connection = connection;
    this.#info = info;
  }

  get disposed(): boolean {
    return this.#reason !== undefined;
  }

  get id(): string {
    return this.#info.sessionId;
  }

  get capabilities(): Bidi.Session.NewResult['capabilities'] {
    return this.#info.capabilities;
  }

  async #initialize(): Promise<void> {
    this.browser.once('closed', ({reason}) => {
      this.#reason = reason;
      this.emit('ended', {reason});
      this.removeAllListeners();
    });
  }

  @throwIfDisposed((session: Session) => {
    // SAFETY: By definition of `disposed`, `#reason` is defined.
    return session.#reason!;
  })
  async end(): Promise<void> {
    await this.connection.send('session.end', {});
    this.#reason = `Session (${this.id}) has already ended.`;
    this.emit('ended', {reason: this.#reason});
    this.removeAllListeners();
  }
}
