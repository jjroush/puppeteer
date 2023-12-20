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
import type Protocol from 'devtools-protocol';

import type {Frame} from '../api/Frame.js';
import {HTTPResponse, type RemoteAddress} from '../api/HTTPResponse.js';
import {UnsupportedOperation} from '../common/Errors.js';
import {invokeAtMostOnceForArguments} from '../util/decorators.js';

import type {BidiHTTPRequest} from './HTTPRequest.js';

/**
 * @internal
 */
export class BidiHTTPResponse extends HTTPResponse {
  #request: BidiHTTPRequest;
  #data: Bidi.Network.ResponseData;

  constructor(request: BidiHTTPRequest, data: Bidi.Network.ResponseData) {
    super();
    this.#request = request;
    this.#data = data;
  }

  @invokeAtMostOnceForArguments
  override remoteAddress(): RemoteAddress {
    return {
      ip: '',
      port: -1,
    };
  }

  override url(): string {
    return this.#data.url;
  }

  override status(): number {
    return this.#data.status;
  }

  override statusText(): string {
    return this.#data.statusText;
  }

  @invokeAtMostOnceForArguments
  override headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    // TODO: Remove once the Firefox implementation is compliant with https://w3c.github.io/webdriver-bidi/#get-the-response-data.
    for (const header of this.#data.headers || []) {
      // TODO: How to handle Binary Headers
      // https://w3c.github.io/webdriver-bidi/#type-network-Header
      if (header.value.type === 'string') {
        headers[header.name.toLowerCase()] = header.value.value;
      }
    }
    return headers;
  }

  override request(): BidiHTTPRequest {
    return this.#request;
  }

  override fromCache(): boolean {
    return this.#data.fromCache;
  }

  override timing(): Protocol.Network.ResourceTiming | null {
    // TODO: File and issue with BiDi spec
    return null;
  }

  override frame(): Frame | null {
    return this.#request.frame();
  }

  override fromServiceWorker(): boolean {
    return false;
  }

  override securityDetails(): never {
    throw new UnsupportedOperation();
  }

  override buffer(): never {
    throw new UnsupportedOperation();
  }
}
