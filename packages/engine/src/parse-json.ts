/**
 * The "Parse JSON" action as the cloud runs it (conformance/flows/parse-json.ff.ts):
 * - text content is read as JSON (Newtonsoft's lenient reader, `newtonsoft-reader.ts`); any
 *   other value is taken as it is, except binary content, which fails (BadRequest) whatever its type;
 * - null or empty content fails the template (BadRequest / InvalidTemplate); whitespace reads as null;
 * - `pattern` / `patternProperties` in the schema fail the action (ActionSchemaNotSupported);
 * - text that is not JSON fails with InvalidJSON and no outputs;
 * - a value the schema rejects fails with ValidationFailed and outputs `{ errors }` (no body);
 * - otherwise the output is `{ body }`, the value as read, never coerced to the schema.
 * Messages name the action type ('ParseJson'), not the action.
 */
import type { CloudError } from './action-status.js';
import { ExpressionError, isBinaryContent } from './expr/values.js';
import { hasUnsupportedKeyword, validateJsonSchema } from './json-schema.js';
import { JsonReaderError, nodeFromValue, nodeToValue, readNewtonsoftJson, type JNode } from './newtonsoft-reader.js';

export interface ParseJsonResult {
  status: 'Succeeded' | 'Failed';
  outputs?: unknown;
  error?: unknown;
  code?: string;
  cloudError?: CloudError;
}

const INVALID_JSON =
  "The 'content' property of actions of type 'ParseJson' must be valid JSON. The provided value cannot be parsed: '{0}'.";
const SCHEMA_NOT_SUPPORTED =
  "The 'schema' property of action '{0}' inputs contains 'pattern' or 'patternProperties' properties. 'Pattern' or 'patternProperties' properties are not supported in the action json schema.";
const NOT_JSON = "The property 'content' must be of type JSON in the '{0}' action inputs, but was of type '{1}'.";
const VALIDATION_FAILED = 'The schema validation failed.';

function failure(code: string, template: string, args: string[] = [], outputs?: unknown): ParseJsonResult {
  const message = template.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)]);
  return {
    status: 'Failed',
    ...(outputs !== undefined ? { outputs } : {}),
    error: Object.assign(new Error(message), { code }),
    code,
    cloudError: { code, message, messageTemplate: template },
  };
}

/** Runs Parse JSON on already-evaluated content and schema. */
export function parseJsonAction(content: unknown, schema: unknown): ParseJsonResult {
  if (content === null || content === undefined || content === '') {
    return { status: 'Failed', error: new ExpressionError("Required property 'content' expects a value but got null. Path ''.") };
  }
  if (hasUnsupportedKeyword(schema)) return failure('ActionSchemaNotSupported', SCHEMA_NOT_SUPPORTED, ['ParseJson']);
  if (isBinaryContent(content)) return failure('BadRequest', NOT_JSON, ['ParseJson', content['$content-type']]);

  let node: JNode;
  if (typeof content === 'string') {
    try {
      node = readNewtonsoftJson(content) ?? { t: 'null' };
    } catch (err) {
      if (!(err instanceof JsonReaderError)) throw err;
      return failure('InvalidJSON', INVALID_JSON, [err.message]);
    }
  } else {
    node = nodeFromValue(content);
  }

  const errors = validateJsonSchema(node, schema);
  if (errors.length) return failure('ValidationFailed', VALIDATION_FAILED, [], { errors });
  return { status: 'Succeeded', outputs: { body: nodeToValue(node) } };
}
