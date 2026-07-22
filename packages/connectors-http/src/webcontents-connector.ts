import type { BaseConnector, RunContext } from '@flowforger/engine';

export interface WebContentsConnectorConfig {
  /** Dataverse token for authenticating to Dataverse Web API */
  dataverseToken?: string;
  /** SharePoint token for authenticating to SharePoint REST API */
  sharepointToken?: string;
}

/**
 * WebContents connector for Power Automate HTTP requests
 * This connector handles the "Invoke an HTTP request" action from Power Automate
 * which uses different parameter naming than the standard HTTP connector
 *
 * Automatically adds Authorization headers for Dataverse and SharePoint requests
 */
export class WebContentsConnector implements BaseConnector {
  constructor(private config: WebContentsConnectorConfig = {}) {}

  async invoke(_operation: string, inputs: any, ctx: RunContext): Promise<any> {
    // Map webcontents parameter format to standard HTTP format
    // Power Automate uses "request/method", "request/url", "request/headers", "request/body"
    const method = (inputs['request/method'] || inputs.method || 'GET').toUpperCase();
    const url = inputs['request/url'] || inputs.url || inputs.uri;

    if (!url) {
      throw new Error('WebContents connector: request/url missing');
    }

    const headers = { ...(inputs['request/headers'] || inputs.headers || {}) };
    const body = inputs['request/body'] || inputs.body;

    // Automatically add Authorization header for Dataverse requests
    if (this.config.dataverseToken && url.includes('.dynamics.com')) {
      if (!headers['Authorization']) {
        headers['Authorization'] = `Bearer ${this.config.dataverseToken}`;
      }
    }

    // Automatically add Authorization header for SharePoint requests
    if (this.config.sharepointToken && url.includes('.sharepoint.com')) {
      if (!headers['Authorization']) {
        headers['Authorization'] = `Bearer ${this.config.sharepointToken}`;
      }
    }

    ctx.log?.({ type: 'webcontents.request', method, url });

    let payload: any = undefined;
    if (body !== undefined) {
      if (typeof body === 'string') {
        payload = body;
      } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) {
        payload = body;
      } else if ((body as any) instanceof Uint8Array || (body as any) instanceof ArrayBuffer) {
        payload = body as any;
      } else {
        payload = JSON.stringify(body);
      }
    }

    const res = await fetch(url, { method, headers, body: payload as any });
    const contentType = res.headers.get('content-type') || '';

    let data: any;
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    ctx.log?.({ type: 'webcontents.response', status: res.status });

    if (!res.ok) {
      // For errors, include full response info
      const headersObj: Record<string, string> = {};
      res.headers.forEach((v, k) => (headersObj[k] = v));
      const errorResponse = { status: res.status, headers: headersObj, body: data };
      const err = new Error(`HTTP ${res.status}`);
      (err as any).response = errorResponse;
      throw err;
    }

    // Return just the body content to match Power Automate behavior
    // In Power Automate, body('HTTP_Action') returns the response body directly
    return data;
  }
}

export default WebContentsConnector;
