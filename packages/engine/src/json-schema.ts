/**
 * JSON Schema validation as the cloud's Parse JSON does it: Newtonsoft.Json.Schema with draft-04
 * keywords (boolean exclusiveMinimum/exclusiveMaximum) plus `const` and `dependencies`, measured
 * by conformance/flows/parse-json.ff.ts. Errors come in document order with Newtonsoft's messages
 * and shape `{ message, lineNumber, linePosition, path, value?, schemaId, errorType, childErrors }`;
 * line info is always 0 because the cloud validates the parsed token, not the text.
 *
 * Per value: the type (a mismatch skips the value's other keywords), then the kind's own keywords
 * (string lengths and format; number bounds; an object's members, an array's items), enum, const,
 * then allOf / anyOf / oneOf / not and schema dependencies, then (objects) required, property
 * counts and key dependencies, (arrays) item counts.
 */
import { jsonPath, nodeToValue, type JNode, type PathSegment } from './newtonsoft-reader.js';
import { numberText } from './expr/values.js';

export interface SchemaError {
  message: string;
  lineNumber: number;
  linePosition: number;
  path: string;
  value?: unknown;
  schemaId: string;
  errorType: string;
  childErrors: SchemaError[];
}

type Schema = Record<string, any>;

/** `pattern` / `patternProperties` anywhere in the schema: the cloud refuses to run the action. */
export function hasUnsupportedKeyword(schema: unknown): boolean {
  let found = false;
  forEachSubschema(schema, (s) => {
    if ('pattern' in s || 'patternProperties' in s) found = true;
  });
  return found;
}

function forEachSubschema(schema: unknown, visit: (s: Schema) => void): void {
  if (!isSchema(schema)) return;
  visit(schema);
  for (const key of ['properties', 'definitions', 'dependencies']) {
    if (isSchema(schema[key])) for (const sub of Object.values(schema[key])) forEachSubschema(sub, visit);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) for (const sub of schema[key]) forEachSubschema(sub, visit);
  }
  if (Array.isArray(schema.items)) for (const sub of schema.items) forEachSubschema(sub, visit);
  for (const key of ['items', 'additionalItems', 'additionalProperties', 'not']) forEachSubschema(schema[key], visit);
}

function isSchema(v: unknown): v is Schema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The schema errors of a parsed value; empty when it is valid. */
export function validateJsonSchema(node: JNode, schema: unknown): SchemaError[] {
  const errors: SchemaError[] = [];
  if (isSchema(schema)) new Validator(schema).validate(node, schema, '#', [], errors);
  return errors;
}

const TYPE_ORDER = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
const TYPE_LABEL: Record<string, string> = {
  string: 'String',
  number: 'Number',
  integer: 'Integer',
  boolean: 'Boolean',
  object: 'Object',
  array: 'Array',
  null: 'Null',
};

class Validator {
  constructor(private readonly root: Schema) {}

  validate(node: JNode, schema: Schema, id: string, path: PathSegment[], errors: SchemaError[]): void {
    // $ref replaces the schema it sits in (draft-04); the target's pointer becomes the schemaId.
    for (let hops = 0; typeof schema.$ref === 'string' && hops < 32; hops++) {
      const target = this.resolve(schema.$ref);
      if (!target) return;
      id = schema.$ref;
      schema = target;
    }
    const raise = (message: string, errorType: string, value?: unknown, childErrors: SchemaError[] = []) =>
      errors.push(makeError(message, path, value, id, errorType, childErrors));

    if (this.checkType(node, schema, raise)) {
      if (node.t === 'string') this.checkString(node.v, schema, raise);
      else if (node.t === 'integer' || node.t === 'float') this.checkNumber(node, schema, raise);
      else if (node.t === 'object') this.checkMembers(node, schema, id, path, errors);
      else if (node.t === 'array') this.checkItems(node, schema, id, path, errors);
      if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => sameJson(node, e))) {
        raise(`Value ${jsonText(node)} is not defined in enum.`, 'enum', primitiveValue(node));
      }
      if ('const' in schema && !sameJson(node, schema.const)) {
        raise(`Value ${jsonText(node)} does not match const.`, 'const', primitiveValue(node));
      }
    }
    this.checkConditionals(node, schema, id, path, raise);
    if (node.t === 'object' && this.typeMatches(node, schema)) this.checkObjectEnd(node, schema, raise);
    if (node.t === 'array' && this.typeMatches(node, schema)) this.checkArrayEnd(node, schema, raise);
  }

  private resolve(ref: string): Schema | undefined {
    if (!ref.startsWith('#')) return undefined;
    let cur: unknown = this.root;
    for (const raw of ref.slice(1).split('/').slice(1)) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!isSchema(cur) && !Array.isArray(cur)) return undefined;
      cur = (cur as any)[key];
    }
    return isSchema(cur) ? cur : undefined;
  }

  private typeMatches(node: JNode, schema: Schema): boolean {
    const types = schemaTypes(schema);
    return !types || types.some((t) => typeAccepts(t, node));
  }

  private checkType(node: JNode, schema: Schema, raise: Raise): boolean {
    if (this.typeMatches(node, schema)) return true;
    const expected = schemaTypes(schema)!
      .filter((t) => t in TYPE_LABEL)
      .sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b))
      .map((t) => TYPE_LABEL[t])
      .join(', ');
    raise(`Invalid type. Expected ${expected} but got ${actualType(node)}.`, 'type', primitiveValue(node));
    return false;
  }

  private checkString(s: string, schema: Schema, raise: Raise): void {
    const length = [...s].length;
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      raise(`String '${s}' exceeds maximum length of ${schema.maxLength}.`, 'maxLength', s);
    }
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      raise(`String '${s}' is less than minimum length of ${schema.minLength}.`, 'minLength', s);
    }
    if (typeof schema.format === 'string' && !formatAccepts(schema.format, s)) {
      raise(`String '${s}' does not validate against format '${schema.format}'.`, 'format', s);
    }
  }

  private checkNumber(node: JNode & { v: number }, schema: Schema, raise: Raise): void {
    const label = node.t === 'integer' ? 'Integer' : 'Float';
    const v = node.v;
    const text = numberText(v);
    if (typeof schema.maximum === 'number') {
      const max = schema.maximum;
      if (schema.exclusiveMaximum === true && v === max) {
        raise(`${label} ${text} equals maximum value of ${numberText(max)} and exclusive maximum is true.`, 'maximum', v);
      } else if (v > max) {
        raise(`${label} ${text} exceeds maximum value of ${numberText(max)}.`, 'maximum', v);
      }
    }
    if (typeof schema.minimum === 'number') {
      const min = schema.minimum;
      if (schema.exclusiveMinimum === true && v === min) {
        raise(`${label} ${text} equals minimum value of ${numberText(min)} and exclusive minimum is true.`, 'minimum', v);
      } else if (v < min) {
        raise(`${label} ${text} is less than minimum value of ${numberText(min)}.`, 'minimum', v);
      }
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf !== 0 && !isMultiple(v, schema.multipleOf)) {
      raise(`${label} ${text} is not a multiple of ${numberText(schema.multipleOf)}.`, 'multipleOf', v);
    }
  }

  private checkMembers(node: JNode & { t: 'object' }, schema: Schema, id: string, path: PathSegment[], errors: SchemaError[]): void {
    const properties = isSchema(schema.properties) ? schema.properties : {};
    for (const [name, value] of node.props) {
      const childPath = [...path, name];
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        if (isSchema(properties[name])) this.validate(value, properties[name], `${id}/properties/${pointerKey(name)}`, childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(
          makeError(`Property '${name}' has not been defined and the schema does not allow additional properties.`, childPath, name, id, 'additionalProperties', []),
        );
      } else if (isSchema(schema.additionalProperties)) {
        this.validate(value, schema.additionalProperties, `${id}/additionalProperties`, childPath, errors);
      }
    }
  }

  private checkItems(node: JNode & { t: 'array' }, schema: Schema, id: string, path: PathSegment[], errors: SchemaError[]): void {
    const seen: JNode[] = [];
    node.items.forEach((item, i) => {
      const childPath = [...path, i];
      if (Array.isArray(schema.items)) {
        if (i < schema.items.length) {
          if (isSchema(schema.items[i])) this.validate(item, schema.items[i], `${id}/items/${i}`, childPath, errors);
        } else if (schema.additionalItems === false) {
          // Newtonsoft counts the index from 1 here ("Index 3" for the item at [2]).
          errors.push(makeError(`Index ${i + 1} has not been defined and the schema does not allow additional items.`, childPath, primitiveValue(item), id, 'additionalItems', []));
        } else if (isSchema(schema.additionalItems)) {
          this.validate(item, schema.additionalItems, `${id}/additionalItems`, childPath, errors);
        }
      } else if (isSchema(schema.items)) {
        this.validate(item, schema.items, `${id}/items`, childPath, errors);
      }
      if (schema.uniqueItems === true) {
        if (seen.some((s) => sameNode(s, item))) {
          errors.push(makeError(`Non-unique array item at index ${i}.`, childPath, nodeToValue(item), id, 'uniqueItems', []));
        }
        seen.push(item);
      }
    });
  }

  private checkConditionals(node: JNode, schema: Schema, id: string, path: PathSegment[], raise: Raise): void {
    const run = (sub: unknown, subId: string): SchemaError[] => {
      const errs: SchemaError[] = [];
      if (isSchema(sub)) this.validate(node, sub, subId, path, errs);
      return errs;
    };
    // Child errors of a combinator come in reverse schema order, as the cloud reports them.
    const reversedChildren = (results: SchemaError[][], indexes: number[]) =>
      [...indexes].reverse().flatMap((i) => results[i]);
    const indexesWhere = (results: SchemaError[][], valid: boolean) =>
      results.flatMap((r, i) => ((r.length === 0) === valid ? [i] : []));

    if (Array.isArray(schema.allOf)) {
      const results = schema.allOf.map((s: unknown, i: number) => run(s, `${id}/allOf/${i}`));
      const invalid = indexesWhere(results, false);
      if (invalid.length) {
        raise(`JSON does not match all schemas from 'allOf'. Invalid schema indexes: ${invalid.join(', ')}.`, 'allOf', undefined, reversedChildren(results, invalid));
      }
    }
    if (Array.isArray(schema.anyOf)) {
      const results = schema.anyOf.map((s: unknown, i: number) => run(s, `${id}/anyOf/${i}`));
      if (indexesWhere(results, true).length === 0) {
        raise(`JSON does not match any schemas from 'anyOf'.`, 'anyOf', undefined, reversedChildren(results, results.map((_: unknown, i: number) => i)));
      }
    }
    if (Array.isArray(schema.oneOf)) {
      const results = schema.oneOf.map((s: unknown, i: number) => run(s, `${id}/oneOf/${i}`));
      const valid = indexesWhere(results, true);
      if (valid.length === 0) {
        raise(`JSON is valid against no schemas from 'oneOf'.`, 'oneOf', undefined, reversedChildren(results, results.map((_: unknown, i: number) => i)));
      } else if (valid.length > 1) {
        raise(`JSON is valid against more than one schema from 'oneOf'. Valid schema indexes: ${valid.join(', ')}.`, 'oneOf');
      }
    }
    if (isSchema(schema.not) && run(schema.not, `${id}/not`).length === 0) {
      raise(`JSON is valid against schema from 'not'.`, 'not');
    }
    if (node.t === 'object' && isSchema(schema.dependencies)) {
      for (const [name, dep] of Object.entries(schema.dependencies)) {
        if (!isSchema(dep) || !hasProp(node, name)) continue;
        const errs = run(dep, `${id}/dependencies/${pointerKey(name)}`);
        if (errs.length) raise(`Dependencies for property '${name}' failed.`, 'dependencies', undefined, errs);
      }
    }
  }

  private checkObjectEnd(node: JNode & { t: 'object' }, schema: Schema, raise: Raise): void {
    if (Array.isArray(schema.required)) {
      const missing = schema.required.filter((k: unknown) => typeof k === 'string' && !hasProp(node, k));
      if (missing.length) raise(`Required properties are missing from object: ${missing.join(', ')}.`, 'required', missing);
    }
    const count = node.props.length;
    if (typeof schema.maxProperties === 'number' && count > schema.maxProperties) {
      raise(`Object property count ${count} exceeds maximum count of ${schema.maxProperties}.`, 'maxProperties', count);
    }
    if (typeof schema.minProperties === 'number' && count < schema.minProperties) {
      raise(`Object property count ${count} is less than minimum count of ${schema.minProperties}.`, 'minProperties', count);
    }
    if (isSchema(schema.dependencies)) {
      for (const [name, dep] of Object.entries(schema.dependencies)) {
        if (!Array.isArray(dep) || !hasProp(node, name)) continue;
        const missing = dep.filter((k) => typeof k === 'string' && !hasProp(node, k));
        if (missing.length) raise(`Dependencies for property '${name}' failed. Missing required keys: ${missing.join(', ')}.`, 'dependencies', name);
      }
    }
  }

  private checkArrayEnd(node: JNode & { t: 'array' }, schema: Schema, raise: Raise): void {
    const count = node.items.length;
    if (typeof schema.maxItems === 'number' && count > schema.maxItems) {
      raise(`Array item count ${count} exceeds maximum count of ${schema.maxItems}.`, 'maxItems', count);
    }
    if (typeof schema.minItems === 'number' && count < schema.minItems) {
      raise(`Array item count ${count} is less than minimum count of ${schema.minItems}.`, 'minItems', count);
    }
  }
}

type Raise = (message: string, errorType: string, value?: unknown, childErrors?: SchemaError[]) => void;

function makeError(message: string, path: PathSegment[], value: unknown, schemaId: string, errorType: string, childErrors: SchemaError[]): SchemaError {
  return {
    message,
    lineNumber: 0,
    linePosition: 0,
    path: jsonPath(path),
    ...(value !== undefined && value !== null ? { value } : {}),
    schemaId,
    errorType,
    childErrors,
  };
}

function schemaTypes(schema: Schema): string[] | undefined {
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((t: unknown): t is string => typeof t === 'string');
  return undefined;
}

function typeAccepts(type: string, node: JNode): boolean {
  switch (type) {
    case 'string':
      return node.t === 'string';
    case 'number':
      return node.t === 'integer' || node.t === 'float';
    case 'integer':
      // A float token with no fraction (1.0) passes as an integer.
      return node.t === 'integer' || (node.t === 'float' && Number.isInteger(node.v));
    case 'boolean':
    case 'object':
    case 'array':
    case 'null':
      return node.t === type;
    case 'any':
      return true;
    default:
      return false;
  }
}

function actualType(node: JNode): string {
  return node.t === 'float' ? 'Number' : TYPE_LABEL[node.t];
}

/** Errors carry the value only for strings, numbers and booleans. */
function primitiveValue(node: JNode): unknown {
  return node.t === 'string' || node.t === 'integer' || node.t === 'float' || node.t === 'boolean' ? nodeToValue(node) : undefined;
}

function hasProp(node: JNode & { t: 'object' }, name: string): boolean {
  return node.props.some(([k]) => k === name);
}

function pointerKey(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** A value as compact JSON, the way Newtonsoft writes a token: a float keeps its `.0`. */
function jsonText(node: JNode): string {
  switch (node.t) {
    case 'object':
      return `{${node.props.map(([k, v]) => `${JSON.stringify(k)}:${jsonText(v)}`).join(',')}}`;
    case 'array':
      return `[${node.items.map(jsonText).join(',')}]`;
    case 'float': {
      const text = numberText(node.v);
      return Number.isFinite(node.v) && !/[.E]/.test(text) ? `${text}.0` : text;
    }
    case 'integer':
      return numberText(node.v);
    case 'null':
      return 'null';
    default:
      return JSON.stringify(node.v);
  }
}

/** JToken.DeepEquals between a parsed value and a schema value: numbers by value, objects regardless of key order. */
function sameJson(node: JNode, v: unknown): boolean {
  switch (node.t) {
    case 'null':
      return v === null;
    case 'string':
    case 'boolean':
      return v === node.v;
    case 'integer':
    case 'float':
      return typeof v === 'number' && v === node.v;
    case 'array':
      return Array.isArray(v) && v.length === node.items.length && node.items.every((item, i) => sameJson(item, v[i]));
    case 'object': {
      if (!isSchema(v)) return false;
      const keys = Object.keys(v);
      return keys.length === node.props.length && node.props.every(([k, x]) => keys.includes(k) && sameJson(x, v[k]));
    }
  }
}

function sameNode(a: JNode, b: JNode): boolean {
  return sameJson(a, nodeToValue(b));
}

/** Whether `v` is a multiple of `m`, allowing for binary rounding (0.3 is a multiple of 0.1). */
function isMultiple(v: number, m: number): boolean {
  const q = v / m;
  return Math.abs(q - Math.round(q)) < 1e-9 * Math.max(1, Math.abs(q));
}

const HOSTNAME =
  /^(?=.{1,255}$)[0-9A-Za-z](?:(?:[0-9A-Za-z]|-){0,61}[0-9A-Za-z])?(?:\.[0-9A-Za-z](?:(?:[0-9A-Za-z]|-){0,61}[0-9A-Za-z])?)*\.?$/;

/** The formats Newtonsoft.Json.Schema checks; any other format is accepted. */
function formatAccepts(format: string, s: string): boolean {
  switch (format) {
    case 'date-time':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/.test(s) && validDate(s.slice(0, 10)) && validTime(s.slice(11, 19));
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(s) && validDate(s);
    case 'time':
      return /^\d{2}:\d{2}:\d{2}$/.test(s) && validTime(s);
    case 'ipv4':
    case 'ip-address': {
      const parts = s.split('.');
      return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
    }
    case 'ipv6':
      return isIpv6(s);
    case 'hostname':
    case 'host-name':
      return HOSTNAME.test(s);
    case 'email':
      return /^[^@]+@[^@]+$/.test(s);
    case 'uri':
      return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !/[\s<>"{}|\\^`]/.test(s) && canParseUrl(s);
    case 'uri-reference':
      return !/[\s<>"{}|\\^`]/.test(s);
    case 'regex':
      try {
        new RegExp(s);
        return true;
      } catch {
        return false;
      }
    default:
      return true;
  }
}

function validDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validTime(s: string): boolean {
  const [h, m, sec] = s.split(':').map(Number);
  return h <= 23 && m <= 59 && sec <= 59;
}

function canParseUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function isIpv6(s: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || !s.includes(':')) return false;
  try {
    return new URL(`http://[${s}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}
