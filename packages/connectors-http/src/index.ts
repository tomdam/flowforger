import type { BaseConnector, RunContext } from '@flowforger/engine';

export class HttpConnector implements BaseConnector {
  async invoke(_operation: string, inputs: any, ctx: RunContext): Promise<any> {
    const method = (inputs.method || 'GET').toUpperCase();
    const url = inputs.url || inputs.uri;
    if (!url) throw new Error('HTTP connector: url/uri missing');
    const headers = inputs.headers || {};
    const body = inputs.body;
    ctx.log?.({ type: 'http.request', method, url });
    let payload: any = undefined;
    if (body !== undefined) {
      if (typeof body === 'string') payload = body;
      else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) payload = body;
      else if ((body as any) instanceof Uint8Array || (body as any) instanceof ArrayBuffer) payload = body as any;
      else payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload as any });
    const contentType = res.headers.get('content-type') || '';
    let data: any;
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    const headersObj: Record<string, string> = {};
    res.headers.forEach((v, k) => (headersObj[k] = v));
    // Use 'statusCode' to match Power Automate's outputs() structure
    const out = { statusCode: res.status, headers: headersObj, body: data };
    ctx.log?.({ type: 'http.response', statusCode: res.status });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      (err as any).response = out;
      throw err;
    }
    return out;
  }
}

export { WebContentsConnector, type WebContentsConnectorConfig } from './webcontents-connector.js';

export default HttpConnector;
