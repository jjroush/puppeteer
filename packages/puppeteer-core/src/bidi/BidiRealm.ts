import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import type {Frame} from '../api/Frame.js';
import {Deferred} from '../util/Deferred.js';

import type {BidiBrowserContext} from './BrowserContext.js';
import type {BidiConnection} from './Connection.js';

export type CallFunctionOptions = Omit<
  Bidi.Script.CallFunctionParameters,
  'functionDeclaration' | 'awaitPromise' | 'target'
>;

export class BidiBidiRealm<RealmInfo extends Bidi.Script.RealmInfo> {
  #browserContext: BidiBrowserContext;
  #info: RealmInfo;
  constructor(browserContext: BidiBrowserContext, info: RealmInfo) {
    this.#browserContext = browserContext;
    this.#info = info;
  }

  get #connection(): BidiConnection {
    return this.#browserContext.browser().connection;
  }

  get #id(): string {
    return this.#info.realm;
  }

  async frame(
    this: BidiBidiRealm<Bidi.Script.WindowRealmInfo>
  ): Promise<Frame> {
    const pages = await this.#browserContext.pages();
    return await Deferred.race(
      pages.map(page => {
        return page.waitForFrame(frame => {
          return frame._id === this.#info.context;
        });
      })
    );
  }

  async callFunction(
    functionDeclaration: string,
    awaitPromise: boolean,
    options: CallFunctionOptions = {}
  ): Promise<Bidi.Script.EvaluateResult> {
    const {result} = await this.#connection.send('script.callFunction', {
      functionDeclaration,
      awaitPromise,
      target: {
        realm: this.#id,
      },
      ...options,
    });
    return result;
  }
}
