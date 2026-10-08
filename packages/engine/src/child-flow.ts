/**
 * "Run a Child Flow" (Workflow action) as the cloud reports it (measured by
 * conformance/flows/child-flow.ff.ts): the parent gets what the child's first Response action
 * answered, as `{ statusCode, headers, body }`.
 *
 * - A response with status < 400 succeeds the call (code 'OK'); >= 400 fails it with the status
 *   name as code ('BadRequest') and the response as outputs. The child's trigger schema and the
 *   PowerApp response schema convert nothing.
 * - A child that ends without responding fails the call with 502 BadGateway and a NoResponse
 *   error body — also when the child itself succeeded (Terminate Succeeded, no Response action).
 * - A child that responds and then fails still succeeds the call.
 * Under the default retry policy the cloud retries the 502 for many minutes, starting the child
 * again each time; locally the call is made once.
 */

import { LOCAL_RUN_NAME } from './action-status.js';

/** What a flow's Response action answered. */
export interface FlowResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
}

const NO_RESPONSE_TEMPLATE = "The server did not receive a response from an upstream server. Request tracking id '{0}'.";

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** A run id shaped like the cloud's ('08584107445807693087817038626CU13'): 29 digits, 'CU', 2 digits. */
function localRunId(): string {
  let digits = '';
  while (digits.length < 29) digits += Math.floor(Math.random() * 10);
  return `${digits}CU${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The call's status and outputs for the child's response (undefined when it never responded).
 * The x-ms-* headers carry local values: the cloud's identify the child run and workflow.
 */
export function childFlowCallResult(
  response: FlowResponse | undefined,
  workflowRef: string,
): { status: 'Succeeded' | 'Failed'; outputs: { statusCode: number; headers: Record<string, string>; body?: unknown } } {
  const childRunId = localRunId();
  const trackingHeaders: Record<string, string> = {
    'x-ms-workflow-run-id': childRunId,
    'x-ms-correlation-id': randomId(),
    'x-ms-client-tracking-id': LOCAL_RUN_NAME,
    'x-ms-trigger-history-name': childRunId,
    'x-ms-execution-location': 'local',
    'x-ms-workflow-system-id': `/locations/local/workflows/${workflowRef}`,
    'x-ms-workflow-id': workflowRef,
    'x-ms-workflow-version': '1',
    'x-ms-workflow-name': workflowRef,
    'x-ms-tracking-id': randomId(),
  };

  if (!response) {
    const body = {
      error: {
        code: 'NoResponse',
        message: NO_RESPONSE_TEMPLATE.replace('{0}', childRunId),
        messageTemplate: NO_RESPONSE_TEMPLATE,
      },
    };
    const text = JSON.stringify(body);
    return {
      status: 'Failed',
      outputs: {
        statusCode: 502,
        headers: { ...trackingHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(byteLength(text)) },
        body,
      },
    };
  }

  const headers: Record<string, string> = { ...trackingHeaders, ...response.headers };
  if (response.body !== undefined && response.body !== null) {
    const isText = typeof response.body === 'string';
    const hasType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
    if (!hasType) headers['Content-Type'] = isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
    headers['Content-Length'] = String(byteLength(isText ? (response.body as string) : JSON.stringify(response.body)));
  }
  const outputs: { statusCode: number; headers: Record<string, string>; body?: unknown } = {
    statusCode: response.statusCode,
    headers,
  };
  if (response.body !== undefined) outputs.body = response.body;
  return { status: response.statusCode >= 400 ? 'Failed' : 'Succeeded', outputs };
}
