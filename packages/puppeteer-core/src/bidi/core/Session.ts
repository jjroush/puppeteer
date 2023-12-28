import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import {EventEmitter} from '../../common/EventEmitter.js';
import {throwIfDisposed} from '../../util/decorators.js';

import type {Connection} from './Connection.js';

export class Session extends EventEmitter<{
  ended: undefined;
}> {
  readonly connection: Connection;
  readonly #info: Bidi.Session.NewResult;

  #ended = false;

  static async create(
    connection: Connection,
    capabilities: Bidi.Session.CapabilitiesRequest
  ): Promise<Session> {
    const {result} = await connection.send('session.new', {
      capabilities,
    });
    return new Session(connection, result);
  }

  constructor(connection: Connection, info: Bidi.Session.NewResult) {
    super();
    this.connection = connection;
    this.#info = info;
  }

  get id(): string {
    return this.#info.sessionId;
  }

  get browserName(): string {
    return this.#info.capabilities.browserName;
  }

  get browserVersion(): string {
    return this.#info.capabilities.browserVersion;
  }

  get disposed(): boolean {
    return this.#ended;
  }

  @throwIfDisposed((session: Session) => {
    return `Session (${session.id}) has already ended.`;
  })
  async end(): Promise<void> {
    await this.connection.send('session.end', {});
    this.#ended = true;
    this.emit('ended', undefined);
  }
}
