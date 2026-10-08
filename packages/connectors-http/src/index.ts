import type { BaseConnector, RunContext } from '@flowforger/engine';
import {
  buildHttpRequest,
  fetchTransport,
  HttpActionError,
  shapeResponse,
  transportError,
  type HttpOutputs,
  type HttpTransport,
} from './cloud-http.js';

export interface HttpConnectorOptions {
  /**
   * Sends the request. Defaults to fetch; Node hosts pass a raw transport (see
   * `@flowforger/debug-node`) so that, as in the cloud, no Accept header is added.
   */
  transport?: HttpTransport;
}

/**
 * The HTTP action. `invoke('request', inputs)` resolves to the action's outputs
 * `{ statusCode, headers, body? }` for every response, error statuses included (the engine
 * decides the action's status), and throws an HttpActionError for a request that got no
 * response or a JSON body that does not parse.
 */
export class HttpConnector implements BaseConnector {
  private readonly transport: HttpTransport;

  constructor(options: HttpConnectorOptions = {}) {
    this.transport = options.transport ?? fetchTransport;
  }

  async invoke(_operation: string, inputs: any, ctx: RunContext): Promise<HttpOutputs> {
    const req = buildHttpRequest(inputs);
    ctx.log?.({ type: 'http.request', method: req.method, url: req.url });
    let res;
    try {
      res = await this.transport(req);
    } catch (err) {
      throw transportError(err, req.url);
    }
    ctx.log?.({ type: 'http.response', statusCode: res.status });
    return shapeResponse(res);
  }
}

export {
  buildHttpRequest,
  buildUrl,
  fetchTransport,
  HttpActionError,
  shapeHeaders,
  shapeResponse,
  transportError,
  type HttpOutputs,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
} from './cloud-http.js';
export { WebContentsConnector, type WebContentsConnectorConfig } from './webcontents-connector.js';

export default HttpConnector;
