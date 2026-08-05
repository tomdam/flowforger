/**
 * Reference functions — read action outputs, trigger data, variables,
 * parameters, and loop state from the RunContext.
 *
 * Trailing property paths (e.g. body('X')?['value'][0]) are applied by the
 * evaluator after these return — entries never handle paths themselves.
 */

import { register } from '../evaluator.js';
import { getActionData } from '../helpers.js';

register('variables', (args, { ctx, ev }) => {
  const varName = String(ev(args[0]));
  if (varName in ctx.variables) return ctx.variables[varName];
  // Case-insensitive fallback (matches Logic Apps behavior)
  const lower = varName.toLowerCase();
  for (const key in ctx.variables) {
    if (key.toLowerCase() === lower) return ctx.variables[key];
  }
  return undefined;
});

// body('X') is shorthand for outputs('X')?['body']: HTTP/connector actions
// store { statusCode, headers, body } — unwrap body; Compose-style actions
// store the value directly — return it as-is.
function bodyOf(out: any): any {
  if (out !== null && typeof out === 'object' && 'body' in out) return out.body;
  return out;
}

register(['body', 'actionBody'], (args, { ctx, ev }) => {
  const actionData = getActionData(ctx, String(ev(args[0])));
  return bodyOf(actionData?.outputs);
});

register('outputs', (args, { ctx, ev }) => getActionData(ctx, String(ev(args[0])))?.outputs);

register('actions', (args, { ctx, ev }) => {
  const actionName = String(ev(args[0]));
  const actionData = getActionData(ctx, actionName);
  if (!actionData) return undefined;
  return {
    name: actionName,
    status: actionData.status,
    outputs: actionData.outputs,
    error: actionData.error,
  };
});

// action() — current (or most recently entered) action's metadata. Combines
// ctx.currentAction (live: name, startTime, inputs) with ctx.actions (live
// status & outputs) so the record reflects the post-execution state when
// referenced from an Until condition.
register('action', (_args, { ctx }) => {
  const cur = ctx.currentAction;
  if (!cur) return undefined;
  const stored = ctx.actions.get(cur.name);
  return {
    name: cur.name,
    inputs: cur.inputs,
    startTime: cur.startTime,
    endTime: cur.endTime,
    status: stored?.status ?? cur.status,
    outputs: stored?.outputs ?? cur.outputs,
  };
});

register('item', (_args, { ctx }) => ctx.variables['item']);

register('items', (args, { ctx, ev }) => {
  const loopName = String(ev(args[0]));
  const val = ctx.variables[loopName];
  if (val === undefined) {
    console.warn(`[items] Warning: No current item found for loop '${loopName}'. Available variables:`, Object.keys(ctx.variables));
  }
  return val;
});

register('trigger', (_args, { ctx }) => {
  const t: any = ctx.triggerData;
  const body = (t !== null && typeof t === 'object' && 'body' in t) ? t.body : t;
  return { outputs: t, body };
});

register('triggerBody', (_args, { ctx }) => {
  const t: any = ctx.triggerData;
  return (t !== null && typeof t === 'object' && 'body' in t) ? t.body : t;
});

register('triggerOutputs', (_args, { ctx }) => ctx.triggerData);

register('workflow', (_args, { ctx }) => ({
  name: ctx.workflowName,
  id: 'local-run',
  run: { name: 'local-run', id: 'local-run' },
}));

register('parameters', (args, { ctx, ev }) => {
  let val: any = ctx.parameters?.[String(ev(args[0]))];
  // A parameter definition object carries its value in defaultValue
  if (val && typeof val === 'object' && 'defaultValue' in val) val = val.defaultValue;
  return val;
});

// iterationIndexes('<loopName>') — index of the named enclosing loop.
// Walks ctx.iterationStack from innermost outward.
register('iterationIndexes', (args, { ctx, ev }) => {
  const loopName = String(ev(args[0]));
  const stack = ctx.iterationStack ?? [];
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].loopName === loopName) return stack[i].index;
  }
  // Fallback: legacy single iterationInfo (covers tests that set it manually).
  if (ctx.iterationInfo?.loopName === loopName) return ctx.iterationInfo.index;
  return undefined;
});

// listCallbackUrl() — returns the trigger's invocation URL. Pre-resolved by
// the host (CLI/web) and stashed on ctx.callbackUrl. Returns '' when the
// host could not (or did not need to) fetch it.
register('listCallbackUrl', (_args, { ctx }) => ctx.callbackUrl ?? '');

// result('<scopedActionName>') — array of child action results within a
// scope/foreach/until. For loops, results from all iterations are concatenated.
register('result', (args, { ctx, ev }) => ctx.scopeResults?.get(String(ev(args[0]))) ?? []);

// Form-data / multipart lookups. PA stores parsed form data either at
// outputs.body (HTTP-shaped) or directly on outputs/triggerData.
function formDataSingle(body: any, key: string, fnName: string): any {
  if (!body || typeof body !== 'object') return undefined;
  const v = body[key];
  if (Array.isArray(v)) {
    if (v.length > 1) throw new Error(`${fnName}: key '${key}' has multiple values; use ${fnName === 'formDataValue' ? 'formDataMultiValues' : 'triggerFormDataMultiValues'}()`);
    return v[0];
  }
  return v;
}

function formDataMulti(body: any, key: string): any[] {
  if (!body || typeof body !== 'object') return [];
  const v = body[key];
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function multipartPart(body: any, idx: number): any {
  const parts = body?.$multipart ?? body?.parts;
  if (!Array.isArray(parts)) return undefined;
  const part = parts[idx];
  return part?.body ?? part?.content ?? part;
}

register('formDataValue', (args, { ctx, ev }) => {
  const out = getActionData(ctx, String(ev(args[0]) ?? ''))?.outputs;
  return formDataSingle(bodyOf(out), String(ev(args[1]) ?? ''), 'formDataValue');
});

register('formDataMultiValues', (args, { ctx, ev }) => {
  const out = getActionData(ctx, String(ev(args[0]) ?? ''))?.outputs;
  return formDataMulti(bodyOf(out), String(ev(args[1]) ?? ''));
});

register('multipartBody', (args, { ctx, ev }) => {
  const out = getActionData(ctx, String(ev(args[0]) ?? ''))?.outputs;
  return multipartPart(bodyOf(out), Number(ev(args[1])));
});

register('triggerFormDataValue', (args, { ctx, ev }) =>
  formDataSingle(bodyOf(ctx.triggerData), String(ev(args[0]) ?? ''), 'triggerFormDataValue'));

register('triggerFormDataMultiValues', (args, { ctx, ev }) =>
  formDataMulti(bodyOf(ctx.triggerData), String(ev(args[0]) ?? '')));

register('triggerMultipartBody', (args, { ctx, ev }) =>
  multipartPart(bodyOf(ctx.triggerData), Number(ev(args[0]))));
