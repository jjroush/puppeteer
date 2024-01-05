/**
 * Copyright 2020 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import type * as Bidi from 'chromium-bidi/lib/cjs/protocol/protocol.js';

import type {CDPSession} from '../api/CDPSession.js';
import type {
  ContinueRequestOverrides,
  ResponseForRequest,
} from '../api/HTTPRequest.js';
import {HTTPRequest, type ResourceType} from '../api/HTTPRequest.js';
import {UnsupportedOperation} from '../common/Errors.js';
import {cached, invokeAtMostOnceForArguments} from '../util/decorators.js';

import type {BidiRequest} from './core/Request.js';
import type {BidiFrame} from './Frame.js';
import {BidiHTTPResponse} from './HTTPResponse.js';

/**
 * @internal
 */
export class BidiHTTPRequest extends HTTPRequest {
  @cached((_, request) => {
    return request;
  })
  static create(
    frame: BidiFrame | undefined,
    bidiRequest: BidiRequest
  ): BidiHTTPRequest {
    const request = new BidiHTTPRequest(frame, bidiRequest);
    void request.#initialize();
    return request;
  }

  #frame: BidiFrame | undefined;
  #request: BidiRequest;

  constructor(frame: BidiFrame | undefined, request: BidiRequest) {
    super();
    this.#frame = frame;
    this.#request = request;
  }

  override get client(): CDPSession {
    throw new Error('Method not implemented.');
  }

  async #initialize(): Promise<void> {}

  override url(): string {
    return this.#request.url;
  }

  override resourceType(): ResourceType {
    return this.initiator().type as ResourceType;
  }

  override method(): string {
    return this.#request.method;
  }

  override postData(): string | undefined {
    return undefined;
  }

  @invokeAtMostOnceForArguments
  override headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const header of this.#request.headers) {
      headers[header.name.toLowerCase()] = header.value.value;
    }
    return headers;
  }

  override response(): BidiHTTPResponse | null {
    if (this.#request.response === undefined) {
      return null;
    }
    return BidiHTTPResponse.create(this, this.#request.response);
  }

  override failure(): {errorText: string} | null {
    if (this.#request.error === undefined) {
      return null;
    }
    return {errorText: this.#request.error};
  }

  override isNavigationRequest(): boolean {
    return !!this.#request.navigation;
  }

  override initiator(): Bidi.Network.Initiator {
    return this.#request.initiator;
  }

  override redirectChain(): BidiHTTPRequest[] {
    if (this.#request.redirect === undefined) {
      return [];
    }

    const redirects = [
      BidiHTTPRequest.create(this.#frame, this.#request.redirect),
    ];
    for (const request of redirects) {
      if (request.#request.redirect !== undefined) {
        redirects.push(
          BidiHTTPRequest.create(this.#frame, request.#request.redirect)
        );
      }
    }
    return redirects;
  }

  override enqueueInterceptAction(
    pendingHandler: () => void | PromiseLike<unknown>
  ): void {
    // Execute the handler when interception is not supported
    void pendingHandler();
  }

  override frame(): BidiFrame | null {
    return this.#frame ?? null;
  }

  override continueRequestOverrides(): never {
    throw new UnsupportedOperation();
  }

  override continue(_overrides: ContinueRequestOverrides = {}): never {
    throw new UnsupportedOperation();
  }

  override responseForRequest(): never {
    throw new UnsupportedOperation();
  }

  override abortErrorReason(): never {
    throw new UnsupportedOperation();
  }

  override interceptResolutionState(): never {
    throw new UnsupportedOperation();
  }

  override isInterceptResolutionHandled(): never {
    throw new UnsupportedOperation();
  }

  override finalizeInterceptions(): never {
    throw new UnsupportedOperation();
  }

  override abort(): never {
    throw new UnsupportedOperation();
  }

  override respond(
    _response: Partial<ResponseForRequest>,
    _priority?: number
  ): never {
    throw new UnsupportedOperation();
  }
}
