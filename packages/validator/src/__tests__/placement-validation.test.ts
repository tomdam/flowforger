import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlowIR, validateLogicApps, type ValidationIssue } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

// ---------------------------------------------------------------------------------------------
// Flow IR helpers
// ---------------------------------------------------------------------------------------------

const httpTrigger = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'http', inputs: {} };
const recurrenceTrigger = { id: 'trg_1', type: 'recurrence', name: 'Recurrence', inputs: { frequency: 'Day', interval: 1 } };
const connectorTrigger = {
  id: 'trg_1', type: 'trigger', name: 'When_item_created', kind: 'connector',
  inputs: { connector: 'sharepoint', operation: 'GetOnNewItems', params: {} },
};

function makeIR(nodes: any[], trigger: any = httpTrigger): FlowIR {
  return { name: 'TestFlow', nodes: [trigger, ...nodes] } as unknown as FlowIR;
}

const compose = (name: string, extra: any = {}) => ({ id: `act_${name}`, type: 'action', name, kind: 'compose', inputs: { value: 1 }, ...extra });
const response = (name: string, extra: any = {}) => ({ id: `act_${name}`, type: 'action', name, kind: 'response', inputs: { statusCode: 200 }, ...extra });
const terminate = (name: string) => ({ id: `act_${name}`, type: 'action', name, kind: 'terminate', inputs: { runStatus: 'Cancelled' } });
const foreach = (name: string, actions: any[]) => ({ id: `fe_${name}`, type: 'foreach', name, itemsExpression: '@createArray(1)', actions });
const dountil = (name: string, actions: any[]) => ({ id: `du_${name}`, type: 'dountil', name, condition: '@true', actions });
const scope = (name: string, actions: any[]) => ({ id: `scp_${name}`, type: 'scope', name, actions });
const ifNode = (name: string, actions: any[], elseActions: any[] = []) => ({ id: `if_${name}`, type: 'if', name, condition: '@true', actions, elseActions });
const switchNode = (name: string, cases: any[][], defaultActions: any[] = []) => ({
  id: `sw_${name}`, type: 'switch', name, expression: '@1',
  cases: cases.map((actions, i) => ({ value: i, actions })), defaultActions,
});

const codes = (r: { issues: ValidationIssue[] }, prefix: string): ValidationIssue[] => r.issues.filter((i) => i.code.startsWith(prefix));

describe('placement rules in validateFlowIR', () => {
  it('Response at the root after an HTTP trigger → no placement issues', () => {
    const r = validateFlowIR(makeIR([compose('A'), response('Respond')]));
    assert.deepEqual(r.issues.filter((i) => /RESPONSE|TERMINATE|NESTING/.test(i.code)), []);
  });

  it('Response inside a foreach → RESPONSE_NESTED error naming the loop', () => {
    const r = validateFlowIR(makeIR([foreach('Each_File', [response('Respond_FileNotFound')])]));
    const e = codes(r, 'RESPONSE_NESTED');
    assert.equal(e.length, 1);
    assert.equal(e[0].level, 'error');
    assert.match(e[0].message, /'Respond_FileNotFound'/);
    assert.match(e[0].message, /foreach .*'Each_File'/);
    assert.match(e[0].message, /could not be nested under an action of type 'foreach'/);
    assert.equal(e[0].path, 'nodes.Respond_FileNotFound');
    assert.equal(r.ok, false);
  });

  it('Response inside a do-until → RESPONSE_NESTED error', () => {
    const r = validateFlowIR(makeIR([dountil('Poll', [response('Respond')])]));
    const e = codes(r, 'RESPONSE_NESTED');
    assert.equal(e.length, 1);
    assert.match(e[0].message, /until .*'Poll'/);
    assert.match(e[0].message, /type 'until'/);
  });

  it('Response nested deeper (foreach → if → scope) → still RESPONSE_NESTED', () => {
    const r = validateFlowIR(makeIR([foreach('Each', [ifNode('Check', [scope('Inner', [response('Respond')])])])]));
    assert.equal(codes(r, 'RESPONSE_NESTED').length, 1);
  });

  it('Response in the else branch / switch case / default under a foreach → RESPONSE_NESTED', () => {
    const r = validateFlowIR(makeIR([
      foreach('Each', [
        ifNode('Check', [], [response('R1')]),
        switchNode('Sw', [[response('R2')]], [response('R3')]),
      ]),
    ]));
    assert.deepEqual(codes(r, 'RESPONSE_NESTED').map((i) => i.path).sort(), ['nodes.R1', 'nodes.R2', 'nodes.R3']);
  });

  it('Response inside if / scope / switch (no loop) → no RESPONSE_NESTED', () => {
    const r = validateFlowIR(makeIR([
      ifNode('Check', [response('R1')], [response('R2')]),
      scope('S', [response('R3')]),
      switchNode('Sw', [[response('R4')]], [response('R5')]),
    ]));
    assert.deepEqual(codes(r, 'RESPONSE_NESTED'), []);
  });

  it('Terminate inside a foreach → TERMINATE_NESTED error', () => {
    const r = validateFlowIR(makeIR([foreach('Each', [terminate('Stop')])]));
    const e = codes(r, 'TERMINATE_NESTED');
    assert.equal(e.length, 1);
    assert.equal(e[0].level, 'error');
    assert.match(e[0].message, /type 'Terminate' that could not be nested under an action of type 'foreach'/);
    assert.match(e[0].message, /flag variable/);
  });

  it('Terminate inside a do-until → TERMINATE_NESTED error', () => {
    const r = validateFlowIR(makeIR([dountil('Poll', [terminate('Stop')])]));
    assert.equal(codes(r, 'TERMINATE_NESTED').length, 1);
  });

  it('Terminate at the root or in an if → no TERMINATE_NESTED', () => {
    const r = validateFlowIR(makeIR([ifNode('Check', [terminate('Stop')]), terminate('End')]));
    assert.deepEqual(codes(r, 'TERMINATE_NESTED'), []);
  });

  it('Response with a recurrence trigger → RESPONSE_TRIGGER error', () => {
    const r = validateFlowIR(makeIR([response('Respond')], recurrenceTrigger));
    const e = codes(r, 'RESPONSE_TRIGGER');
    assert.equal(e.length, 1);
    assert.equal(e[0].level, 'error');
    assert.match(e[0].message, /recurrence trigger \('Recurrence'\)/);
  });

  it('Response with a polling connector trigger (recurrence) → RESPONSE_TRIGGER error naming the connector', () => {
    const polling = { ...connectorTrigger, inputs: { ...(connectorTrigger as any).inputs, recurrence: { frequency: 'Minute', interval: 5 } } };
    const r = validateFlowIR(makeIR([response('Respond')], polling));
    const e = codes(r, 'RESPONSE_TRIGGER');
    assert.equal(e.length, 1);
    assert.match(e[0].message, /sharepoint GetOnNewItems/);
  });

  it('Response with a webhook connector trigger (no recurrence) → no RESPONSE_TRIGGER', () => {
    const r = validateFlowIR(makeIR([response('Respond')], connectorTrigger));
    assert.deepEqual(codes(r, 'RESPONSE_TRIGGER'), []);
  });

  it('Response with a manual (button / PowerAppV2) trigger → no RESPONSE_TRIGGER', () => {
    const manual = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'manual', inputs: { triggerKind: 'PowerAppV2' } };
    const r = validateFlowIR(makeIR([response('Respond', { inputs: { statusCode: 200, kind: 'PowerApp' } })], manual));
    assert.deepEqual(codes(r, 'RESPONSE_TRIGGER'), []);
  });

  it('Response in a parallel branch is allowed (the cloud saves it; conformance/save-rules/placement)', () => {
    const r = validateFlowIR(makeIR([
      compose('GetData'),
      compose('A'),
      response('Respond', { runAfter: { GetData: ['Succeeded'] } }),
    ]));
    assert.deepEqual(r.issues.filter((i) => i.level !== 'info'), []);
  });

  it('an action at nesting level 9 (inside 9 blocks) → NESTING_DEPTH error on the outermost one past the limit', () => {
    let inner: any[] = [compose('Deep')];
    for (let i = 10; i >= 1; i--) inner = [scope(`S${i}`, inner)];
    const r = validateFlowIR(makeIR(inner));
    const e = codes(r, 'NESTING_DEPTH');
    assert.equal(e.length, 1);
    assert.equal(e[0].level, 'error');
    assert.equal(e[0].path, 'nodes.S10');
    assert.match(e[0].message, /nested at level '9' which exceeds the maximum nesting limit of '8'/);
  });

  it('an action at nesting level 8 (inside 8 blocks) → no NESTING_DEPTH', () => {
    let inner: any[] = [compose('Deep')];
    for (let i = 8; i >= 1; i--) inner = [scope(`S${i}`, inner)];
    const r = validateFlowIR(makeIR(inner));
    assert.deepEqual(codes(r, 'NESTING_DEPTH'), []);
  });
});

// ---------------------------------------------------------------------------------------------
// Logic Apps JSON
// ---------------------------------------------------------------------------------------------

function makeLA(actions: Record<string, any>, trigger: any = { type: 'Request', kind: 'Http', inputs: {} }) {
  return { definition: { $schema: 'x', contentVersion: '1.0.0.0', triggers: { manual: trigger }, actions } };
}
const laCompose = (runAfter: any = {}) => ({ type: 'Compose', inputs: 1, runAfter });
const laResponse = (runAfter: any = {}) => ({ type: 'Response', kind: 'Http', inputs: { statusCode: 200 }, runAfter });
const laTerminate = (runAfter: any = {}) => ({ type: 'Terminate', inputs: { runStatus: 'Cancelled' }, runAfter });
const laForeach = (actions: Record<string, any>, runAfter: any = {}) => ({ type: 'Foreach', foreach: '@createArray(1)', actions, runAfter });
const laUntil = (actions: Record<string, any>) => ({ type: 'Until', expression: '@true', limit: { count: 5, timeout: 'PT1H' }, actions, runAfter: {} });
const laScope = (actions: Record<string, any>) => ({ type: 'Scope', actions, runAfter: {} });

describe('placement rules in validateLogicApps', () => {
  it('Response at the root of a Request-triggered flow → no placement issues', () => {
    const r = validateLogicApps(makeLA({ A: laCompose(), Respond: laResponse({ A: ['Succeeded'] }) }));
    assert.deepEqual(r.issues.filter((i) => /RESPONSE|TERMINATE|NESTING|VAR_INIT/.test(i.code)), []);
  });

  it('Response inside Foreach → RESPONSE_NESTED with a JSON path', () => {
    const r = validateLogicApps(makeLA({ Each_File: laForeach({ Respond_FileNotFound: laResponse() }) }));
    const e = codes(r, 'RESPONSE_NESTED');
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'definition.actions.Each_File.actions.Respond_FileNotFound');
    assert.match(e[0].message, /'Respond_FileNotFound' has type 'Response' that could not be nested under an action of type 'foreach'/);
    assert.equal(r.ok, false);
  });

  it('Response inside Until (nested in a Scope, inside a Condition else branch) → RESPONSE_NESTED', () => {
    const r = validateLogicApps(makeLA({
      Poll: laUntil({
        Check: { type: 'If', expression: { equals: [1, 1] }, actions: {}, else: { actions: { Respond: laResponse() } }, runAfter: {} },
      }),
    }));
    const e = codes(r, 'RESPONSE_NESTED');
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'definition.actions.Poll.actions.Check.else.actions.Respond');
    assert.match(e[0].message, /type 'until'/);
  });

  it('Terminate inside Foreach → TERMINATE_NESTED; Terminate in a Scope → fine', () => {
    const r = validateLogicApps(makeLA({
      Each: laForeach({ Stop: laTerminate() }),
      Wrap: laScope({ End: laTerminate() }),
    }));
    assert.deepEqual(codes(r, 'TERMINATE_NESTED').map((i) => i.path), ['definition.actions.Each.actions.Stop']);
  });

  it('Response with a Recurrence trigger → RESPONSE_TRIGGER', () => {
    const r = validateLogicApps(makeLA({ Respond: laResponse() }, { type: 'Recurrence', recurrence: { frequency: 'Day', interval: 1 } }));
    const e = codes(r, 'RESPONSE_TRIGGER');
    assert.equal(e.length, 1);
    assert.match(e[0].message, /recurrence trigger \("manual"\)/);
  });

  it('Response with a polling OpenApiConnection trigger → RESPONSE_TRIGGER naming the operation', () => {
    const trigger = { type: 'OpenApiConnection', recurrence: { frequency: 'Minute', interval: 5 }, inputs: { host: { operationId: 'GetOnNewItems' } } };
    const r = validateLogicApps(makeLA({ Respond: laResponse() }, trigger));
    const e = codes(r, 'RESPONSE_TRIGGER');
    assert.equal(e.length, 1);
    assert.match(e[0].message, /GetOnNewItems/);
  });

  it('Response with a Request trigger of kind PowerApp → no RESPONSE_TRIGGER', () => {
    const r = validateLogicApps(makeLA({ Respond: laResponse() }, { type: 'Request', kind: 'PowerAppV2', inputs: {} }));
    assert.deepEqual(codes(r, 'RESPONSE_TRIGGER'), []);
  });

  it('InitializeVariable inside a Scope → VAR_INIT_NESTED error', () => {
    const r = validateLogicApps(makeLA({
      Init_ok: { type: 'InitializeVariable', inputs: { variables: [{ name: 'a', type: 'integer' }] }, runAfter: {} },
      Wrap: laScope({ Init_nested: { type: 'InitializeVariable', inputs: { variables: [{ name: 'b', type: 'integer' }] }, runAfter: {} } }),
    }));
    assert.deepEqual(codes(r, 'VAR_INIT_NESTED').map((i) => i.path), ['definition.actions.Wrap.actions.Init_nested']);
  });

  it('an action inside 9 blocks → NESTING_DEPTH error', () => {
    let inner: Record<string, any> = { Deep: laCompose() };
    for (let i = 9; i >= 1; i--) inner = { [`S${i}`]: laScope(inner) };
    const r = validateLogicApps(makeLA(inner));
    const e = codes(r, 'NESTING_DEPTH');
    assert.equal(e.length, 1);
    assert.equal(e[0].level, 'error');
    assert.match(e[0].path!, /\.Deep$/);
  });
});
