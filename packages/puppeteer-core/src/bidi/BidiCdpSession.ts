import type ProtocolMapping from 'devtools-protocol/types/protocol-mapping.js';

import {CDPSession} from '../api/CDPSession.js';
import type {Connection as CdpConnection} from '../cdp/Connection.js';
import {TargetCloseError, UnsupportedOperation} from '../common/Errors.js';
import {assert} from '../util/assert.js';
import {Deferred} from '../util/Deferred.js';

import type {BrowsingContext} from './BrowsingContext.js';
import type {BidiConnection} from './Connection.js';

/**
 * @internal
 */
export const cdpSessions = new Map<string, BidiCdpSession>();

/**
 * @internal
 */
export class BidiCdpSession extends CDPSession {
  #context: BrowsingContext;
  #sessionId = Deferred.create<string>();
  #detached = false;

  constructor(context: BrowsingContext, sessionId?: string) {
    super();
    this.#context = context;

    if (!this.supported) {
      return;
    }

    (async () => {
      let id;
      if (sessionId) {
        id = sessionId;
      } else {
        const {
          result: {session},
        } = await this.#connection.send('cdp.createSession', {
          context: context.id,
        });
        assert(session);
        id = session;
      }
      this.#sessionId.resolve(id);
      cdpSessions.set(id, this);
    })();
  }

  get #connection(): BidiConnection {
    return this.#context.browserContext.browser().connection;
  }

  get supported(): boolean {
    return this.#context.browserContext.browser().cdpSupported;
  }

  get disposed(): boolean {
    return this.#detached;
  }

  override connection(): CdpConnection | undefined {
    return undefined;
  }

  override async send<T extends keyof ProtocolMapping.Commands>(
    method: T,
    ...paramArgs: ProtocolMapping.Commands[T]['paramsType']
  ): Promise<ProtocolMapping.Commands[T]['returnType']> {
    if (!this.supported) {
      throw new UnsupportedOperation(
        'CDP support is required for this feature. The current browser does not support CDP.'
      );
    }
    if (this.#detached) {
      throw new TargetCloseError(
        `Protocol error (${method}): Session closed. Most likely the page has been closed.`
      );
    }
    const session = await this.#sessionId.valueOrThrow();
    const {result} = await this.#connection.send('cdp.sendCommand', {
      method: method,
      params: paramArgs[0],
      session,
    });
    return result.result;
  }

  override async detach(): Promise<void> {
    if (this.#detached) {
      return;
    }
    this.#detached = true;

    cdpSessions.delete(this.id());
    if (this.#context.browserContext.browser().cdpSupported) {
      await this.send('Target.detachFromTarget', {
        sessionId: this.id(),
      });
    }
  }

  override id(): string {
    const value = this.#sessionId.value();
    return typeof value === 'string' ? value : '';
  }
}
