import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tryEvaluate } from '../expr/evaluator.js';
import '../expr/functions/index.js';
import { makeExprContext } from './expr-fixtures.js';

const ctx = makeExprContext();
const ok = (e: string, c = ctx) => {
  const r = tryEvaluate(e, c);
  assert.equal(r.ok, true, `expected ok for ${e}: ${(r as any).reason ?? ''}`);
  return (r as { ok: true; value: any }).value;
};

describe('reference functions', () => {
  it('body unwraps { body }', () => assert.equal(ok(`@body('GetRows')?['value'][0].id`), 7));
  it('body of bare outputs (Compose)', () => assert.equal(ok(`@body('ComposeX')`), 42));
  it('body is case-insensitive on action name', () => assert.equal(ok(`@body('getrows')?['value'][0].id`), 7));
  it('outputs returns full structure', () => assert.equal(ok(`@outputs('HttpCall')['statusCode']`), 500));
  it('actions record', () => {
    assert.equal(ok(`@actions('HttpCall').status`), 'Failed');
    assert.equal(ok(`@actions('HttpCall').error.message`), 'boom');
    assert.equal(ok(`@actions('Missing')`), undefined);
  });
  it('actionBody alias', () => assert.equal(ok(`@actionBody('GetRows')['value'][0].name`), 'row7'));
  it('trigger family', () => {
    assert.equal(ok(`@triggerBody().id`), 'trg-1');
    assert.equal(ok(`@triggerOutputs()['body/nested/deep']`), 'yes');
    assert.equal(ok(`@trigger().body.id`), 'trg-1');
    assert.equal(ok(`@trigger().outputs.headers.h1`), 'v1');
  });
  it('workflow / parameters', () => {
    assert.equal(ok(`@workflow().name`), 'TestFlow');
    assert.equal(ok(`@workflow().run.id`), 'local-run');
    assert.equal(ok(`@parameters('Site')`), 'https://contoso');
    assert.equal(ok(`@parameters('WithDefault')`), 'dv'); // defaultValue unwrap
    assert.equal(ok(`@parameters('Missing')`), undefined);
  });
  it('item and items read ctx.variables', () => {
    assert.deepEqual(ok(`@item()`), { current: true });
    assert.equal(ok(`@item().current`), true);
    assert.equal(ok(`@items('Rows')[0].id`), 1);
  });
  it('action() combines currentAction with stored status/outputs', () => {
    const c = makeExprContext();
    (c as any).currentAction = { name: 'HttpCall', inputs: { u: 1 }, startTime: 't0' };
    assert.equal(ok('@action().status', c), 'Failed'); // stored status wins
    assert.equal(ok('@action().inputs.u', c), 1);
    assert.equal(ok('@action().name', c), 'HttpCall');
    const empty = makeExprContext();
    assert.equal(ok('@action()', empty), undefined); // no current action
  });
  it('result() returns scoped child results', () => {
    const c = makeExprContext();
    (c as any).scopeResults.set('Scope1', [{ name: 'a', status: 'Succeeded' }]);
    assert.deepEqual(ok(`@result('Scope1')`, c), [{ name: 'a', status: 'Succeeded' }]);
    assert.deepEqual(ok(`@result('Nope')`, c), []);
  });
  it('iterationIndexes walks the stack innermost-out', () => {
    const c = makeExprContext();
    (c as any).iterationStack = [{ loopName: 'Outer', index: 2 }, { loopName: 'Inner', index: 7 }];
    assert.equal(ok(`@iterationIndexes('Inner')`, c), 7);
    assert.equal(ok(`@iterationIndexes('Outer')`, c), 2);
    assert.equal(ok(`@iterationIndexes('Nope')`, c), undefined);
  });
  it('iterationIndexes falls back to legacy iterationInfo', () => {
    const c = makeExprContext();
    (c as any).iterationStack = [];
    (c as any).iterationInfo = { loopName: 'L', index: 4 };
    assert.equal(ok(`@iterationIndexes('L')`, c), 4);
  });
  it('listCallbackUrl', () => {
    assert.equal(ok('@listCallbackUrl()'), '');
    const c = makeExprContext();
    (c as any).callbackUrl = 'http://cb';
    assert.equal(ok('@listCallbackUrl()', c), 'http://cb');
  });
  it('formDataValue / formDataMultiValues', () => {
    const c = makeExprContext();
    (c as any).actions.set('Form', { status: 'Succeeded', outputs: { body: { single: 'v1', multi: ['a', 'b'], one: ['x'] } } });
    assert.equal(ok(`@formDataValue('Form', 'single')`, c), 'v1');
    assert.equal(ok(`@formDataValue('Form', 'one')`, c), 'x');
    assert.deepEqual(ok(`@formDataMultiValues('Form', 'multi')`, c), ['a', 'b']);
    assert.deepEqual(ok(`@formDataMultiValues('Form', 'single')`, c), ['v1']);
    assert.deepEqual(ok(`@formDataMultiValues('Form', 'missing')`, c), []);
  });
  it('multipartBody', () => {
    const c = makeExprContext();
    (c as any).actions.set('Multi', { status: 'Succeeded', outputs: { body: { $multipart: [{ body: 'part0' }, { content: 'part1' }] } } });
    assert.equal(ok(`@multipartBody('Multi', 0)`, c), 'part0');
    assert.equal(ok(`@multipartBody('Multi', 1)`, c), 'part1');
    assert.equal(ok(`@multipartBody('Multi', 9)`, c), undefined);
  });
  it('trigger formData / multipart', () => {
    const c = makeExprContext();
    (c as any).triggerData = { body: { k: 'v', m: ['1', '2'], $multipart: [{ body: 'tp0' }] } };
    assert.equal(ok(`@triggerFormDataValue('k')`, c), 'v');
    assert.deepEqual(ok(`@triggerFormDataMultiValues('m')`, c), ['1', '2']);
    assert.equal(ok(`@triggerMultipartBody(0)`, c), 'tp0');
  });
});
