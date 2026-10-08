/**
 * Reference functions — read action outputs, trigger data, variables,
 * parameters, and loop state from the RunContext.
 *
 * Trailing property paths (e.g. body('X')?['value'][0]) are applied by the
 * evaluator after these return — entries never handle paths themselves.
 */

import { register } from '../evaluator.js';
import { getActionData } from '../helpers.js';
import { ExpressionError } from '../values.js';
import { LOCAL_RUN_NAME, toCloudRecord } from '../../action-status.js';
import { triggerRecord } from '../../trigger-outputs.js';

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
  // A connector or HTTP response without content (204, DELETE) has no body, as in the cloud.
  if (out !== null && typeof out === 'object' && typeof out.statusCode === 'number') return undefined;
  return out;
}

// Actions whose outputs are always `{ body }`: when they fail without one (Parse JSON's
// `{ errors }`), body() is null, not the outputs (conformance/flows/parse-json.ff.ts).
const BODY_OUTPUT_KINDS = new Set(['parsejson', 'select', 'filterarray', 'join', 'createcsvtable', 'createhtmltable']);

register(['body', 'actionBody'], (args, { ctx, ev }) => {
  const actionData = getActionData(ctx, String(ev(args[0])));
  if (BODY_OUTPUT_KINDS.has(actionData?.kind)) return actionData.outputs?.body;
  return bodyOf(actionData?.outputs);
});

register('outputs', (args, { ctx, ev }) => getActionData(ctx, String(ev(args[0])))?.outputs);

// actions('X') — the action's record in the cloud's shape (name, inputs, outputs, times, code, status, error).
register('actions', (args, { ctx, ev }) => {
  const actionName = String(ev(args[0]));
  const actionData = getActionData(ctx, actionName);
  if (!actionData) return undefined;
  return toCloudRecord(actionName, actionData);
});

// action() — current (or most recently entered) action's metadata. Combines
// ctx.currentAction (live: name, startTime, inputs) with ctx.actions (live
// status & outputs) so the record reflects the post-execution state when
// referenced from an Until condition.
/** A function the cloud allows only where it has something to read (not in a Compose or a condition). */
const notExpectedHere = (name: string) => new ExpressionError(`The template function '${name}' is not expected at this location.`);

// In a flow the cloud accepts action() only in trackedProperties, which no local run evaluates:
// a Compose or an Until condition fails. The debugger console still answers it.
register('action', (_args, { ctx }) => {
  if (!ctx.debugEvaluation) throw notExpectedHere('action');
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

register('trigger', (_args, { ctx }) => triggerRecord(ctx.trigger, ctx.triggerData));

register('triggerBody', (_args, { ctx }) => {
  const t: any = ctx.triggerData;
  return (t !== null && typeof t === 'object' && 'body' in t) ? t.body : t;
});

register('triggerOutputs', (_args, { ctx }) => ctx.triggerData);

// workflow() — error notifications read tags.flowDisplayName (and tags.environmentName, which
// only a host that knows the environment can fill in).
register('workflow', (_args, { ctx }) => ({
  name: ctx.workflowName,
  id: LOCAL_RUN_NAME,
  tags: { flowDisplayName: ctx.workflowName, ...(ctx.environmentName ? { environmentName: ctx.environmentName } : {}) },
  run: { name: LOCAL_RUN_NAME, id: LOCAL_RUN_NAME },
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
// A Button (manual) trigger has no callback URL: the cloud fails the call.
register('listCallbackUrl', (_args, { ctx }) => {
  if (ctx.trigger?.kind === 'Button' && !ctx.debugEvaluation) throw notExpectedHere('listCallbackUrl');
  return ctx.callbackUrl ?? '';
});

// appsetting() belongs to Logic Apps Standard; a Power Automate / Logic Apps flow fails the call.
register('appsetting', () => {
  throw notExpectedHere('appsetting');
});

// result('<scopedActionName>') — the block's direct children in the cloud's record shape. A
// foreach lists each child once, with every iteration's record as its outputs; an Until lists
// the last iteration's (see index.ts).
register('result', (args, { ctx, ev }) =>
  (ctx.scopeResults?.get(String(ev(args[0]))) ?? []).map(r => toCloudRecord(r.name, r)));

// Form-data / multipart lookups (conformance/flows/formdata-*.ff.ts). The content type comes
// from the outputs' Content-Type header, so a Compose of a form body (no headers) is not form
// data; fields come from the body's $formdata (a form post) or $multipart parts (multipart data,
// a part named by its Content-Disposition), as the Request trigger stores them.
const FORM_TYPES = /^(multipart\/form-data|application\/x-www-form-urlencoded)\b/i;

function contentTypeOf(outputs: any): string | undefined {
  const headers = outputs && typeof outputs === 'object' ? outputs.headers : undefined;
  if (!headers || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
  return key ? String(headers[key]) : undefined;
}

const notRetrieved = (fn: string, what: string, why: string) =>
  new ExpressionError(`The template language function '${fn}' failed to retrieve ${what} contents from outputs. ${why}`);

function formFields(fn: string, outputs: any, key: string): unknown[] {
  const type = contentTypeOf(outputs);
  if (!type || !FORM_TYPES.test(type)) {
    throw notRetrieved(fn, 'formdata',
      `The output content is not a valid form data content. Supported form data content types are 'multipart/form-data' and 'application/x-www-form-urlencoded' and the provided content type is '${type ?? '<null>'}'.`);
  }
  const body = bodyOf(outputs);
  if (Array.isArray(body?.$formdata)) {
    return body.$formdata.filter((f: any) => f?.key === key).map((f: any) => f.value);
  }
  return multipartParts(body).filter((p) => partName(p) === key).map((p) => p.body);
}

function multipartParts(body: any): Array<{ headers?: Record<string, string>; body: unknown }> {
  return Array.isArray(body?.$multipart) ? body.$multipart : [];
}

function partName(part: { headers?: Record<string, string> }): string | undefined {
  const headers = part.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-disposition');
  const m = key ? /\bname="([^"]*)"|\bname=([^;\s]+)/i.exec(headers[key]) : null;
  return m ? (m[1] ?? m[2]) : undefined;
}

function formValue(fn: string, outputs: any, key: string): unknown {
  const values = formFields(fn, outputs, key);
  if (values.length > 1) throw notRetrieved(fn, 'formdata', `There are more than one items matching the field name '${key}'.`);
  return values.length ? values[0] : null;
}

function multipartBody(fn: string, outputs: any, index: number): unknown {
  const type = contentTypeOf(outputs);
  if (!type || !/^multipart\//i.test(type)) {
    throw notRetrieved(fn, 'multipart',
      `The supported multipart content type is 'multipart/*' and the provided content type is '${type ?? '<null>'}'. `);
  }
  const parts = multipartParts(bodyOf(outputs));
  if (!(index >= 0 && index < parts.length)) {
    throw notRetrieved(fn, 'multipart', `The index value '${index}' exceeds the number of multipart contents '${parts.length}' in the outputs.`);
  }
  return parts[index].body;
}

const actionOutputs = (ctx: any, name: unknown) => getActionData(ctx, String(name ?? ''))?.outputs;

register('formDataValue', (args, { ctx, ev }) =>
  formValue('formDataValue', actionOutputs(ctx, ev(args[0])), String(ev(args[1]) ?? '')));
register('formDataMultiValues', (args, { ctx, ev }) =>
  formFields('formDataMultiValues', actionOutputs(ctx, ev(args[0])), String(ev(args[1]) ?? '')));
register('multipartBody', (args, { ctx, ev }) =>
  multipartBody('multipartBody', actionOutputs(ctx, ev(args[0])), Number(ev(args[1]))));
register('triggerFormDataValue', (args, { ctx, ev }) =>
  formValue('triggerFormDataValue', ctx.triggerData, String(ev(args[0]) ?? '')));
register('triggerFormDataMultiValues', (args, { ctx, ev }) =>
  formFields('triggerFormDataMultiValues', ctx.triggerData, String(ev(args[0]) ?? '')));
register('triggerMultipartBody', (args, { ctx, ev }) =>
  multipartBody('triggerMultipartBody', ctx.triggerData, Number(ev(args[0]))));
