import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTypeScriptDefinition,
  getTypeScriptQuickInfo,
  removeDocument,
} from '../src/embedded-ts/service.js';

const URI = 'file:///c:/Projects/test/sample.ff.ts';

const CODE = [
  `@Flow("Sample")`,
  `export class Sample {`,
  `  @Action()`,
  `  async run(ctx: FlowContext) {`,
  `    let varName: string = "";`,
  `    varName = ctx.outputs('Get_Account')?.['body/name'];`,
  `    for (const item of [1, 2]) {`,
  `      varName = String(item);`,
  `    }`,
  `  }`,
  `  constructor() {}`,
  `}`,
].join('\n');

const offsetOf = (needle: string, occurrence = 1): number => {
  let from = 0;
  for (let i = 0; i < occurrence; i++) {
    const at = CODE.indexOf(needle, from);
    if (at < 0) throw new Error(`needle not found: ${needle}`);
    from = at + 1;
  }
  return from - 1;
};

test('definition of a bare flow-variable reference resolves to its let declaration', () => {
  try {
    const declOffset = offsetOf('varName', 1);
    const useOffset = offsetOf('varName = ctx');
    const defs = getTypeScriptDefinition(URI, CODE, useOffset + 2);
    assert.equal(defs.length, 1);
    assert.equal(defs[0].start, declOffset);
    assert.equal(defs[0].length, 'varName'.length);
  } finally {
    removeDocument(URI);
  }
});

test('definition of a for-of loop variable resolves to the loop header', () => {
  try {
    const declOffset = offsetOf('item of');
    const useOffset = offsetOf('String(item)') + 'String('.length;
    const defs = getTypeScriptDefinition(URI, CODE, useOffset);
    assert.equal(defs.length, 1);
    assert.equal(defs[0].start, declOffset);
  } finally {
    removeDocument(URI);
  }
});

test('definitions outside the document (ambient ctx types) are not returned', () => {
  try {
    const useOffset = offsetOf('outputs(');
    const defs = getTypeScriptDefinition(URI, CODE, useOffset + 1);
    assert.deepEqual(defs, []);
  } finally {
    removeDocument(URI);
  }
});

test('quick info for a bare identifier names the symbol and its type', () => {
  try {
    const useOffset = offsetOf('varName = ctx');
    const info = getTypeScriptQuickInfo(URI, CODE, useOffset + 2);
    assert.ok(info, 'expected quick info');
    assert.match(info!.text, /let varName: string/);
    assert.equal(info!.start, useOffset);
    assert.equal(info!.length, 'varName'.length);
  } finally {
    removeDocument(URI);
  }
});

test('quick info on whitespace returns null', () => {
  try {
    const info = getTypeScriptQuickInfo(URI, CODE, offsetOf('    let') + 1);
    assert.equal(info, null);
  } finally {
    removeDocument(URI);
  }
});
