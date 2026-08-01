import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evalExpression } from '../expressions.js';
import type { RunContext } from '../index.js';

/**
 * Property navigation on the reference functions. body()/outputs()/item()/
 * triggerBody() have always supported paths; variables() supported none, and
 * parameters()/actions()/result()/trigger()/workflow() supported dot notation
 * only — so `variables('obj')['key']` fell through every branch and returned
 * the expression text verbatim instead of the value.
 */

const OBJ = {
  CreateZugferdAzureFunctionUrl: 'https://fa.example.net/api/http_trigger',
  CreateZugferdSourceLibraryName: 'Accounting',
  nested: { deep: 'D' },
  'slash/key': 'not-nested',
};

function makeContext(): RunContext {
  return {
    variables: {
      FunctionParametersAsObject: OBJ,
      Rows: [{ id: 1, name: 'first' }, { id: 2, name: 'second' }],
      Nested: { a: { b: { c: 'abc' } } },
      Count: 3,
    },
    actions: new Map([
      ['GetRows', { status: 'Succeeded', outputs: { body: { value: [{ id: 7 }] } } }],
    ]),
    triggerData: { body: OBJ },
    workflowName: 'test',
    parameters: { Config: OBJ, WithDefault: { defaultValue: OBJ } },
    now: () => new Date('2026-01-01T00:00:00Z'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
    secrets: () => undefined,
    connector: () => { throw new Error('no connector'); },
  };
}

describe('variables() property navigation', () => {
  const ctx = makeContext();

  it('resolves bracket notation on an object variable', () => {
    assert.equal(
      evalExpression(`@variables('FunctionParametersAsObject')['CreateZugferdAzureFunctionUrl']`, ctx),
      OBJ.CreateZugferdAzureFunctionUrl,
    );
  });

  it('resolves optional bracket notation', () => {
    assert.equal(
      evalExpression(`@variables('FunctionParametersAsObject')?['CreateZugferdSourceLibraryName']`, ctx),
      'Accounting',
    );
  });

  it('resolves dot notation', () => {
    assert.equal(
      evalExpression(`@variables('FunctionParametersAsObject').CreateZugferdSourceLibraryName`, ctx),
      'Accounting',
    );
  });

  it('resolves array index and chained access', () => {
    assert.equal(evalExpression(`@variables('Rows')[1]['name']`, ctx), 'second');
    assert.equal(evalExpression(`@variables('Rows')[0].id`, ctx), 1);
  });

  it('resolves deep chains', () => {
    assert.equal(evalExpression(`@variables('Nested')['a']['b']['c']`, ctx), 'abc');
    assert.equal(evalExpression(`@variables('Nested')?['a']?['b']?['c']`, ctx), 'abc');
  });

  it('navigates case-insensitively on the variable name', () => {
    assert.equal(
      evalExpression(`@variables('functionparametersasobject')['CreateZugferdSourceLibraryName']`, ctx),
      'Accounting',
    );
  });

  it('returns undefined for a missing key instead of the expression text', () => {
    assert.equal(evalExpression(`@variables('FunctionParametersAsObject')['nope']`, ctx), undefined);
  });

  it('still returns the whole value with no path', () => {
    assert.deepEqual(evalExpression(`@variables('FunctionParametersAsObject')`, ctx), OBJ);
    assert.equal(evalExpression(`@variables('Count')`, ctx), 3);
  });

  it('works nested inside another function', () => {
    assert.equal(
      evalExpression(`@concat(variables('FunctionParametersAsObject')['CreateZugferdSourceLibraryName'], '!')`, ctx),
      'Accounting!',
    );
    assert.equal(
      evalExpression(`@length(variables('Rows'))`, ctx),
      2,
    );
  });

  it('works inside an @{...} template', () => {
    assert.equal(
      evalExpression(`@{variables('FunctionParametersAsObject')['CreateZugferdSourceLibraryName']}`, ctx),
      'Accounting',
    );
  });
});

describe('bracket notation on the other reference functions', () => {
  const ctx = makeContext();

  it('parameters()', () => {
    assert.equal(evalExpression(`@parameters('Config')['CreateZugferdSourceLibraryName']`, ctx), 'Accounting');
    assert.equal(evalExpression(`@parameters('Config').CreateZugferdSourceLibraryName`, ctx), 'Accounting');
    assert.equal(evalExpression(`@parameters('WithDefault')['nested']['deep']`, ctx), 'D');
  });

  it('actions()', () => {
    assert.equal(evalExpression(`@actions('GetRows')['status']`, ctx), 'Succeeded');
    assert.equal(evalExpression(`@actions('GetRows').status`, ctx), 'Succeeded');
    assert.equal(evalExpression(`@actions('GetRows')['outputs']['body']['value'][0]['id']`, ctx), 7);
  });

  it('trigger()', () => {
    assert.equal(evalExpression(`@trigger()['body']['CreateZugferdSourceLibraryName']`, ctx), 'Accounting');
    assert.deepEqual(evalExpression(`@trigger().body`, ctx), OBJ);
  });

  it('workflow()', () => {
    assert.equal(evalExpression(`@workflow()['name']`, ctx), 'test');
    assert.equal(evalExpression(`@workflow().name`, ctx), 'test');
    assert.equal(evalExpression(`@workflow()['run']['name']`, ctx), 'local-run');
  });

  it('body()/outputs() keep working (no regression)', () => {
    assert.equal(evalExpression(`@body('GetRows')['value'][0]['id']`, ctx), 7);
    assert.equal(evalExpression(`@outputs('GetRows')['body']['value'][0]['id']`, ctx), 7);
    assert.equal(evalExpression(`@triggerBody()['CreateZugferdSourceLibraryName']`, ctx), 'Accounting');
  });
});
