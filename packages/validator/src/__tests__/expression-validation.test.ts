import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlowIR, validateLogicApps } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

function makeIR(nodes: any[]): FlowIR {
  return {
    name: 'TestFlow',
    nodes: [
      { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'http' },
      ...nodes,
    ],
  } as unknown as FlowIR;
}

describe('expression validation in validateFlowIR', () => {
  it('flags an unknown function as a warning (ok stays true)', () => {
    const r = validateFlowIR(makeIR([
      { id: 'act_1', type: 'action', name: 'A', kind: 'http', inputs: { method: 'GET', url: `@varaibles('x')` } },
    ]));
    const w = r.issues.filter(i => i.code === 'EXPR_UNKNOWN_FUNCTION');
    assert.equal(w.length, 1);
    assert.equal(w[0].level, 'warning');
    assert.match(w[0].message, /varaibles/);
    assert.equal(r.ok, true);
  });

  it('flags a syntax error as an error (ok false) with a path', () => {
    const r = validateFlowIR(makeIR([
      { id: 'act_1', type: 'action', name: 'A', kind: 'http', inputs: { method: 'GET', url: `@concat('a'` } },
    ]));
    const e = r.issues.filter(i => i.code === 'EXPR_SYNTAX');
    assert.equal(e.length, 1);
    assert.equal(e[0].level, 'error');
    assert.match(e[0].path ?? '', /inputs\.url/);
    assert.equal(r.ok, false);
  });

  it('valid templates pass; broken template segments are errors', () => {
    const good = validateFlowIR(makeIR([
      { id: 'act_1', type: 'action', name: 'A', kind: 'http', inputs: { method: 'GET', url: `x eq '@{variables('x')}'` } },
    ]));
    assert.equal(good.issues.filter(i => i.code.startsWith('EXPR_')).length, 0);

    const bad = validateFlowIR(makeIR([
      { id: 'act_1', type: 'action', name: 'A', kind: 'http', inputs: { method: 'GET', url: `x @{concat('a'} y` } },
    ]));
    assert.equal(bad.issues.filter(i => i.code === 'EXPR_SYNTAX').length, 1);
    assert.equal(bad.ok, false);
  });

  it('ignores @@ escapes, plain strings, and expression-ish KEYS', () => {
    const r = validateFlowIR(makeIR([
      {
        id: 'act_1', type: 'action', name: 'A', kind: 'http',
        inputs: { method: 'GET', url: 'https://x', body: { '@odata.type': 'plain', note: '@@literal at', email: 'a@b.com' } },
      },
    ]));
    assert.equal(r.issues.filter(i => i.code.startsWith('EXPR_')).length, 0);
  });

  it('finds expressions in nested control structures', () => {
    const r = validateFlowIR(makeIR([
      {
        id: 'fe_1', type: 'foreach', name: 'Loop', itemsExpression: `@body('X')`,
        actions: [
          { id: 'act_2', type: 'action', name: 'Inner', kind: 'compose', inputs: { value: `@bogusFn(item())` } },
        ],
      },
    ]));
    const w = r.issues.filter(i => i.code === 'EXPR_UNKNOWN_FUNCTION');
    assert.equal(w.length, 1);
    assert.match(w[0].message, /bogusFn/);
  });

  it('reports each distinct unknown function once per expression', () => {
    const r = validateFlowIR(makeIR([
      { id: 'act_1', type: 'action', name: 'A', kind: 'compose', inputs: { value: `@bogus(bogus(other()))` } },
    ]));
    const w = r.issues.filter(i => i.code === 'EXPR_UNKNOWN_FUNCTION');
    assert.equal(w.length, 2); // bogus, other — deduped
  });
});

describe('expression validation in validateLogicApps', () => {
  const def = (triggers: any, actions: any = {}) => ({ definition: { triggers, actions } });

  it('flags bad trigger expressions with a definition path', () => {
    const r = validateLogicApps(def({
      manual: { type: 'Request', splitOn: `@triggerBody()?['value'` },
    }));
    const e = r.issues.filter(i => i.code === 'EXPR_SYNTAX');
    assert.equal(e.length, 1);
    assert.match(e[0].path ?? '', /definition\.triggers\.manual/);
    assert.equal(r.ok, false);
  });

  it('clean definitions stay clean', () => {
    const r = validateLogicApps(def(
      { manual: { type: 'Request' } },
      { Compose: { type: 'Compose', inputs: `@concat('a', variables('x'))` } },
    ));
    assert.equal(r.issues.filter(i => i.code.startsWith('EXPR_')).length, 0);
    assert.equal(r.ok, true);
  });
});
