/**
 * How the cloud describes an action's outcome to `actions()` and `result()`: a `code`
 * ('OK', 'NotFound', 'ActionFailed', 'ActionSkipped', ...) and, for failures and skips, an
 * `error` object whose messages are fixed templates. Measured by conformance/flows/control.ff.ts.
 */

import type { Node, StepResult } from '@flowforger/ir';
import { ExpressionError, typeName } from './expr/values.js';

export interface CloudError {
  code: string;
  message: string;
  messageTemplate?: string;
}

/** The cloud's code and error for one action, as `actions()` / `result()` report them. */
export interface Outcome {
  code?: string;
  cloudError?: CloudError;
}

const TEMPLATES = {
  actionFailed: 'An action failed. No dependent actions succeeded.',
  runAfter:
    "The execution of template action '{0}' is skipped: the 'runAfter' condition for action '{1}' is not satisfied. Expected status values '{2}' and actual value '{3}'.",
  branch: "The execution of template action '{0}' skipped: the branching condition for this action is not satisfied.",
  dependency:
    "The execution of template action '{0}' is skipped: dependant action '{1}' completed with status '{2}' and code '{3}'.",
  template: "Unable to process template language expressions in action '{0}' inputs at line '{1}' and column '{2}': '{3}'.",
  condition: "Unable to process template language expressions for action '{0}' at line '{1}' and column '{2}': '{3}'.",
  switchValue:
    "The execution of template action '{0}' failed: The result of the evaluation of 'scope' action expression '{1}' is not valid. It is of type '{2}' but is expected to be a value of type '{3}'.",
};

function cloudError(code: string, template: string, ...args: unknown[]): CloudError {
  const message = template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)]));
  return { code, message, messageTemplate: template };
}

/** Node types whose children run inside them; the cloud reports these without outputs. */
export const CONTROL_TYPES = new Set(['scope', 'if', 'switch', 'foreach', 'dountil']);

/** Action kinds the cloud reports with code 'NotSpecified' (variables, terminate). */
const NOT_SPECIFIED_KINDS = new Set([
  'initializevariable',
  'setvariable',
  'incrementvariable',
  'decrementvariable',
  'appendtoarrayvariable',
  'appendtostringvariable',
  'terminate',
]);

/** A node's kind for record shaping: the action kind for plain actions, else the node type. */
export function nodeKind(node: Node): string {
  return node.type === 'action' ? (node as any).kind : node.type;
}

/**
 * The .NET Framework HttpStatusCode name the cloud uses as a connector/HTTP action's code.
 * Statuses that enum has no name for (429, 422, ...) are written as the number ("429",
 * measured by conformance/flows/http.ff.ts).
 */
export function httpStatusName(status: number): string {
  return HTTP_STATUS_NAMES[status] ?? String(status);
}

const HTTP_STATUS_NAMES: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'NonAuthoritativeInformation',
  204: 'NoContent',
  205: 'ResetContent',
  206: 'PartialContent',
  301: 'MovedPermanently',
  302: 'Found',
  300: 'MultipleChoices',
  303: 'SeeOther',
  304: 'NotModified',
  307: 'TemporaryRedirect',
  400: 'BadRequest',
  401: 'Unauthorized',
  402: 'PaymentRequired',
  403: 'Forbidden',
  404: 'NotFound',
  405: 'MethodNotAllowed',
  406: 'NotAcceptable',
  407: 'ProxyAuthenticationRequired',
  408: 'RequestTimeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'LengthRequired',
  412: 'PreconditionFailed',
  413: 'RequestEntityTooLarge',
  414: 'RequestUriTooLong',
  415: 'UnsupportedMediaType',
  416: 'RequestedRangeNotSatisfiable',
  417: 'ExpectationFailed',
  500: 'InternalServerError',
  501: 'NotImplemented',
  502: 'BadGateway',
  503: 'ServiceUnavailable',
  504: 'GatewayTimeout',
  505: 'HttpVersionNotSupported',
};

/** Skipped because a runAfter dependency finished in a status the action doesn't accept. */
export function skippedByRunAfter(name: string, dependency: string, expected: string[], actual: string | undefined): Outcome {
  return {
    code: 'ActionSkipped',
    cloudError: cloudError('ActionConditionFailed', TEMPLATES.runAfter, name, dependency, expected.join(', '), actual),
  };
}

/**
 * A block whose own expression (an Until condition) fails to evaluate (conformance/flows/expr-errors.ff.ts).
 * The cloud gives the expression's line and column in the deployed definition, which a local
 * run cannot know: line 1, column 0 here.
 */
export function conditionInvalid(name: string, message: string): Outcome {
  return { code: 'BadRequest', cloudError: cloudError('InvalidTemplate', TEMPLATES.condition, name, 1, 0, message) };
}

/** Skipped because it sits in an If branch or Switch case that was not taken. */
export function skippedByBranch(name: string): Outcome {
  return { code: 'ActionSkipped', cloudError: cloudError('ActionBranchingConditionNotSatisfied', TEMPLATES.branch, name) };
}

/** Skipped because the block containing it was skipped or failed before running it. */
export function skippedByParent(name: string, parent: string, parentStatus: string, parentCode: string | undefined): Outcome {
  return {
    code: 'ActionSkipped',
    cloudError: cloudError('ActionDependencyFailed', TEMPLATES.dependency, name, parent, parentStatus, parentCode ?? 'NotSpecified'),
  };
}

/** Skipped because a Terminate ended the run first. */
export const SKIPPED_BY_TERMINATE: Outcome = { code: 'Terminated' };

/** A block (scope/if/switch/loop) that failed because something inside it failed. */
export const BLOCK_FAILED: Outcome = { code: 'ActionFailed', cloudError: cloudError('ActionFailed', TEMPLATES.actionFailed) };

/** A Switch whose expression is not a string or an integer. */
export function switchValueInvalid(name: string, expression: string, value: unknown): Outcome {
  return {
    code: 'ExpressionEvaluationFailed',
    cloudError: cloudError('ExpressionEvaluationFailed', TEMPLATES.switchValue, name, expression, typeName(value), 'String, Integer'),
  };
}

/**
 * A Switch branch action when a case value's type differs from the expression's: the cloud
 * compares with the type-strict `strongEquals`, which throws, and every branch action fails.
 */
export function switchCaseTypeMismatch(name: string, valueType: string, caseType: string): Outcome {
  const message =
    `The execution of template action '${name}' failed: an unexpected exception encountered when evaluating branching condition. ` +
    `'Template language function 'strongEquals' expects parameters of same type, but found '${valueType},${caseType}' distinct types.'`;
  return { code: 'InternalServerError', cloudError: { code: 'ActionConditionFailed', message, messageTemplate: 'ActionConditionFailed' } };
}

/**
 * The cloud's code and error for an executed node's result. An outcome the node already set
 * (a Switch failure, a terminated block) wins; otherwise it follows from the node's kind and status.
 */
export function describeOutcome(
  node: Node,
  result: { status: StepResult['status']; outputs?: any; error?: any } & Outcome,
): Outcome {
  if (result.code !== undefined || result.cloudError !== undefined) return { code: result.code, cloudError: result.cloudError };
  const kind = nodeKind(node);
  if (result.status === 'Skipped') return { code: 'ActionSkipped' };
  if (result.status === 'Cancelled') return SKIPPED_BY_TERMINATE;
  if (CONTROL_TYPES.has(kind)) return result.status === 'Failed' ? BLOCK_FAILED : { code: 'NotSpecified' };
  const statusCode = result.outputs?.statusCode;
  if (typeof statusCode === 'number' && (node.type === 'connector' || kind === 'http' || kind === 'workflow')) {
    return { code: httpStatusName(statusCode) };
  }
  if (result.status === 'Failed') {
    const err = result.error;
    const message = err?.message ?? String(err);
    if (err instanceof ExpressionError || err?.name === 'ExpressionError') {
      return { code: 'BadRequest', cloudError: cloudError('InvalidTemplate', TEMPLATES.template, node.name, 0, 0, message) };
    }
    return { code: 'BadRequest', cloudError: { code: 'BadRequest', message } };
  }
  return { code: NOT_SPECIFIED_KINDS.has(kind) ? 'NotSpecified' : 'OK' };
}

/** What an action's stored record holds that `actions()` / `result()` read. */
export interface ActionRecordLike extends Outcome {
  status: StepResult['status'];
  inputs?: any;
  outputs?: any;
  error?: any;
  kind?: string;
  startTime?: string;
  endTime?: string;
  trackingId?: string;
  /** Foreach children in `result()`: the child's record from every iteration. */
  repetitions?: ActionRecordLike[];
  repetitionCount?: number;
}

/** The run id locally; `workflow().run.name` returns the same. */
export const LOCAL_RUN_NAME = 'local-run';

/**
 * An action as `actions('X')` and each `result('Scope')` item show it in the cloud:
 * `{ name, inputs, outputs, startTime, endTime, trackingId, clientTrackingId, code, status, error }`.
 * Blocks have no inputs/outputs, a failed expression leaves both out, a connector's inputs are
 * `{ parameters }` (the cloud adds `host`), and a code of 'NotSpecified' is not shown.
 */
export function toCloudRecord(name: string, rec: ActionRecordLike): Record<string, unknown> {
  const out: Record<string, unknown> = { name };
  if (rec.repetitions) {
    out.outputs = rec.repetitions.map(r => toCloudRecord(name, r));
  } else if (!(rec.kind !== undefined && CONTROL_TYPES.has(rec.kind))) {
    const inputs =
      rec.inputs !== undefined
        ? rec.kind === 'connector' ? { parameters: rec.inputs } : rec.inputs
        : rec.kind === 'compose' && rec.status === 'Succeeded' ? rec.outputs : undefined;
    if (inputs !== undefined) out.inputs = inputs;
    if (rec.outputs !== undefined) out.outputs = rec.outputs;
  }
  if (rec.startTime !== undefined) out.startTime = rec.startTime;
  if (rec.endTime !== undefined) out.endTime = rec.endTime;
  if (rec.trackingId !== undefined) {
    out.trackingId = rec.trackingId;
    out.clientTrackingId = LOCAL_RUN_NAME;
  }
  if (rec.code !== undefined && (rec.code !== 'NotSpecified' || rec.repetitions)) out.code = rec.code;
  if (rec.status !== undefined) out.status = rec.status;
  // Records made outside the engine's run loop (tests, hosts) carry only the thrown error.
  const error = rec.cloudError ?? (rec.code === undefined && rec.error ? plainError(rec.error) : undefined);
  if (error) out.error = error;
  if (rec.repetitionCount !== undefined) out.repetitionCount = rec.repetitionCount;
  return out;
}

function plainError(err: any): Record<string, unknown> {
  if (err && typeof err === 'object' && !(err instanceof Error)) return err;
  return { ...(err?.code ? { code: err.code } : {}), message: err?.message ?? String(err) };
}
