/**
 * The HTTP action as the cloud runs it around the request itself (measured by
 * conformance/flows/http.ff.ts): the record of its inputs, which answers fail it, its retry
 * policy, and the asynchronous 202 + Location pattern.
 *
 * - A response with status >= 400 fails the action, with `{ statusCode, headers, body }` as its
 *   outputs and the status name as its code ('NotFound', '429', ...); no `error`.
 * - A request that got no response (an unresolvable host) or a JSON body that does not parse
 *   fails it without outputs, with the cloud's code and error (from the connector's HttpActionError).
 * - Retries: the default policy (no `retryPolicy`) retries 408, 429 and 5xx answers up to 4
 *   times at exponential intervals (7.5 s scale, 5–45 s); a `Retry-After` header sets the wait.
 *   `fixed` / `exponential` policies retry the same answers; `none` never retries. In the cloud a
 *   Power Platform endpoint answering 503 makes this take ~15 minutes, so tests set `none`.
 * - 202 with a Location header: the action polls the Location with GET (honouring Retry-After)
 *   until the answer is not 202, and that answer is its outcome. `DisableAsyncPattern` in
 *   operationOptions turns this off.
 */

import type { ActionNode } from '@flowforger/ir';
import type { BaseConnector, ExecuteNodeResult, RunContext } from './index.js';
import { evaluateParams } from './expressions.js';

const SANITIZED = '*sanitized*';
const SECRET_FIELDS = new Set(['password', 'value', 'secret', 'pfx', 'clientsecret']);

const POLICY_TYPES: Record<string, string> = { none: 'None', fixed: 'Fixed', exponential: 'Exponential' };

/** The action's inputs as `actions('X')?['inputs']` shows them: `uri`, secrets sanitized, policy type capitalized. */
export function httpInputsRecord(inputs: any, retryPolicy: any): Record<string, unknown> {
  const { url, uri, method, authentication, ...rest } = inputs ?? {};
  const record: Record<string, unknown> = { uri: uri ?? url, method, ...rest };
  for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];
  if (retryPolicy) record.retryPolicy = policyRecord(retryPolicy);
  if (authentication && typeof authentication === 'object') {
    record.authentication = Object.fromEntries(
      Object.entries(authentication).map(([k, v]) => [k, SECRET_FIELDS.has(k.toLowerCase()) ? SANITIZED : v]),
    );
  }
  return record;
}

/** A retry policy as the cloud records it in an action's inputs (`{ type: 'None' }`). */
export function policyRecord(policy: any): Record<string, unknown> {
  const type = String(policy?.type ?? '');
  return { ...policy, type: POLICY_TYPES[type.toLowerCase()] ?? type };
}

/** Milliseconds of an ISO 8601 duration ('PT20S') or a number of milliseconds. */
export function durationMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value);
  if (!m) return undefined;
  const [, d, h, min, s] = m;
  return Number(d || 0) * 86_400_000 + Number(h || 0) * 3_600_000 + Number(min || 0) * 60_000 + Number(s || 0) * 1000;
}

function retryAfterMs(headers: Record<string, string> | undefined, now: Date): number | undefined {
  const key = Object.keys(headers ?? {}).find(k => k.toLowerCase() === 'retry-after');
  if (!key) return undefined;
  const v = headers![key].trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** How long to wait before retry number `retry` (1-based), or undefined when the policy gives up. */
export function retryDelayMs(policy: any, retry: number, retryAfter: number | undefined): number | undefined {
  const type = String(policy?.type ?? 'default').toLowerCase();
  if (type === 'none') return undefined;
  const count = type === 'default' ? 4 : Number(policy.count ?? 4);
  if (retry > count) return undefined;
  if (retryAfter !== undefined) return retryAfter;
  if (type === 'fixed') return durationMs(policy.interval) ?? 20_000;
  const scale = type === 'default' ? 7_500 : (durationMs(policy.interval) ?? 7_500);
  const min = type === 'default' ? 5_000 : (durationMs(policy.minimumInterval) ?? 5_000);
  const max = type === 'default' ? 45_000 : (durationMs(policy.maximumInterval) ?? 3_600_000);
  return Math.min(max, Math.max(min, scale * 2 ** (retry - 1)));
}

/** Polling interval when a 202 answer carries no Retry-After. */
const DEFAULT_POLL_MS = 10_000;

/** One HTTP action, start to end. Throws only for expression failures in its inputs. */
export async function executeHttpAction(action: ActionNode, ctx: RunContext, http: BaseConnector): Promise<ExecuteNodeResult> {
  const evaluated = evaluateParams(action.inputs, ctx);
  const policy = (action as any).retryPolicy;
  const inputs = httpInputsRecord(evaluated, policy);
  ctx.currentAction && (ctx.currentAction.inputs = inputs);
  const asyncPattern = !String((action as any).operationOptions ?? '').toLowerCase().includes('disableasyncpattern');
  const done = (r: Omit<ExecuteNodeResult, 'variables' | 'inputs'>): ExecuteNodeResult => ({
    ...r,
    inputs,
    variables: { ...ctx.variables },
  });

  for (let retry = 1; ; retry++) {
    let outputs: any;
    try {
      outputs = await http.invoke('request', evaluated, ctx);
      while (asyncPattern && outputs.statusCode === 202 && locationOf(outputs.headers)) {
        const wait = retryAfterMs(outputs.headers, ctx.now()) ?? DEFAULT_POLL_MS;
        ctx.log({ type: 'http.poll', location: locationOf(outputs.headers), waitMs: wait });
        await ctx.sleep(wait);
        outputs = await http.invoke(
          'request',
          { method: 'GET', uri: locationOf(outputs.headers), authentication: evaluated.authentication },
          ctx,
        );
      }
    } catch (err: any) {
      // A failure that never got a response, or a JSON body that does not parse.
      if (err?.name !== 'HttpActionError') throw err;
      return done({ status: 'Failed', error: err, code: err.code, cloudError: err.cloudError });
    }
    if (outputs.statusCode < 400) return done({ status: 'Succeeded', outputs });
    const delay = isRetryableStatus(outputs.statusCode)
      ? retryDelayMs(policy, retry, retryAfterMs(outputs.headers, ctx.now()))
      : undefined;
    if (delay === undefined) {
      return done({ status: 'Failed', outputs, error: new Error(`HTTP ${outputs.statusCode}`) });
    }
    ctx.log({ type: 'http.retry', statusCode: outputs.statusCode, retry, waitMs: delay });
    await ctx.sleep(delay);
  }
}

function locationOf(headers: Record<string, string> | undefined): string | undefined {
  const key = Object.keys(headers ?? {}).find(k => k.toLowerCase() === 'location');
  return key ? headers![key] : undefined;
}
