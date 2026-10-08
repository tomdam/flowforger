/**
 * The conformance flows (conformance/flows, helpers included) use the designer's full input
 * shapes, so they must type-check against the editor typings (monaco-types.ts) that the web app
 * and VS Code show errors from. A field the transformer understands but the typings lack
 * (ctx.http's `queries`, `cookie`) fails here instead of in the editor.
 *
 * The web app shows a deployed flow as DSL generated from its Logic Apps JSON, so each flow is
 * also checked after that round trip (DSL → IR → JSON → IR → DSL): the generated DSL must parse
 * (an expression status code of ctx.response once came out as raw `@int(...)`), and compiling it
 * again must give the same expressions (max() once came back as the invalid `@Math.max(...)`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { generateNativeDslFromIR, parseLogicAppsToIR, transformCode, transformFile } from '@flowforger/dsl-native';
import { emitLogicAppsJson } from '@flowforger/emitter-logicapps';
import { getTypeScriptDiagnostics, removeDocument } from '../src/embedded-ts/service.js';

const FLOWS = join(dirname(fileURLToPath(import.meta.url)), '../../../conformance/flows');

function flowFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? flowFiles(join(dir, e.name)) : e.name.endsWith('.ff.ts') ? [join(dir, e.name)] : [],
  );
}

/** TypeScript errors of one DSL text, as `<label>:<line>:<col> TS<code> <message>`. */
function typeErrors(label: string, uri: string, text: string): string[] {
  const errors = getTypeScriptDiagnostics(uri, text).map((d) => {
    const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
    const where = pos ? `${pos.line + 1}:${pos.character + 1}` : '?';
    return `${label}:${where} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
  removeDocument(uri);
  return errors;
}

const files = flowFiles(FLOWS);
const label = (file: string) => file.slice(FLOWS.length + 1).replace(/\\/g, '/');

test('conformance flows type-check against the editor typings', () => {
  assert.ok(files.length > 0, `no flows found under ${FLOWS}`);
  const errors = files.flatMap((file) => typeErrors(label(file), pathToFileURL(file).href, readFileSync(file, 'utf8')));
  assert.deepEqual(errors, []);
});

/** DSL as the web app shows a deployed flow: generated from the flow's Logic Apps JSON. */
async function roundTrip(file: string) {
  const ir = await transformFile(file);
  const before = emitLogicAppsJson(ir) as any;
  const dsl = generateNativeDslFromIR(parseLogicAppsToIR(before, { flowName: ir.name }), { flowName: ir.name });
  return { dsl, before, after: emitLogicAppsJson(transformCode(dsl)) as any };
}

test('conformance flows generated from Logic Apps JSON parse as TypeScript', async () => {
  // Syntax errors only (TS1xxx): the generator writes expressions with typed ctx helpers, so a
  // probe that feeds a function a wrong type on purpose (length(5)) is a type error by design.
  const errors: string[] = [];
  for (const file of files) {
    const { dsl } = await roundTrip(file);
    const uri = pathToFileURL(file.replace(/\.ff\.ts$/, '.generated.ff.ts')).href;
    errors.push(...typeErrors(`${label(file)} (generated)`, uri, dsl).filter((e) => / TS1\d{3} /.test(e)));
  }
  assert.deepEqual(errors, []);
});

/** Leaves of a JSON value by path, without metadata and descriptions. */
function leaves(v: unknown, path = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) if (k !== 'metadata' && k !== 'description') leaves(x, path ? `${path}.${k}` : k, out);
  } else out[path] = v;
  return out;
}

/** Whitespace outside string literals does not change an expression. */
const normalize = (v: unknown) => (typeof v === 'string' ? v.replace(/'(?:[^']|'')*'|\s+/g, (m) => (m.startsWith("'") ? m : '')) : v);

test('conformance flows keep every expression through the web app round trip', async () => {
  const changed: string[] = [];
  for (const file of files) {
    const { before, after } = await roundTrip(file);
    const a = leaves(before.properties.definition.actions);
    const b = leaves(after.properties.definition.actions);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (normalize(a[key]) === normalize(b[key])) continue;
      // `@createArray(1)` comes back as the literal [1]: the same value.
      const parent = key.replace(/\.\d+$/, '');
      if (typeof a[parent] === 'string' && /^@createArray\(/.test(a[parent] as string)) continue;
      if (/^@createArray\(/.test(String(a[key])) && b[key] === undefined) continue;
      changed.push(`${label(file)}: ${key}: ${JSON.stringify(a[key])} → ${JSON.stringify(b[key])}`);
    }
  }
  assert.deepEqual(changed, []);
});
