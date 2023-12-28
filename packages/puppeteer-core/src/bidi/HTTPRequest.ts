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

import {FrameEvent, type Frame} from '../api/Frame.js';
import type {
  ContinueRequestOverrides,
  ResponseForRequest,
} from '../api/HTTPRequest.js';
import {HTTPRequest, type ResourceType} from '../api/HTTPRequest.js';
import {PageEvent} from '../api/Page.js';
import {UnsupportedOperation} from '../common/Errors.js';
import {invokeAtMostOnceForArguments} from '../util/decorators.js';

import type {BidiFrame} from './Frame.js';
import {BidiHTTPResponse} from './HTTPResponse.js';
import type {BidiRequest} from './core/Request.js';

/**
 * @internal
 */
export class BidiHTTPRequest extends HTTPRequest {
  #frame: BidiFrame | undefined;
  #request: BidiRequest;

  #response?: BidiHTTPResponse;
  #failure?: {errorText: string};

  constructor(frame: BidiFrame | undefined, request: BidiRequest) {
    super();

    this.#frame = frame;
    this.#request = request;

    this.#request
      .response()
      .valueOrThrow()
      .then(
        response => {
          this.#response = new BidiHTTPResponse(this, response);
          if (!this.#frame) {
            return;
          }

          this.#frame.bubbleEmit(FrameEvent.Response, this.#response);
          this.#frame.page().emit(PageEvent.Response, this.#response);

          this.#frame.bubbleEmit(FrameEvent.RequestFinished, this);
          this.#frame.page().emit(PageEvent.RequestFinished, this);
        },
        error => {
          this.#failure = {errorText: error.message};
          if (!this.#frame) {
            return;
          }

          this.#frame.bubbleEmit(FrameEvent.RequestFailed, this);
          this.#frame.page().emit(PageEvent.RequestFailed, this);
        }
      );
  }

  override get client(): never {
    throw new UnsupportedOperation();
  }

  override url(): string {
    return this.#request.url;
  }

  override resourceType(): ResourceType {
    return this.initiator().type.toLowerCase() as ResourceType;
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
    return this.#response ?? null;
  }

  override failure(): {errorText: string} | null {
    return this.#failure ?? null;
  }

  override isNavigationRequest(): boolean {
    return !!this.#request.navigation;
  }

  override initiator(): Bidi.Network.Initiator {
    return this.#request.initiator;
  }

  override redirectChain(): BidiHTTPRequest[] {
    // TODO: Implement redirect.
    return [];
  }

  override enqueueInterceptAction(
    pendingHandler: () => void | PromiseLike<unknown>
  ): void {
    // Execute the handler when interception is not supported
    void pendingHandler();
  }

  override frame(): Frame | null {
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
