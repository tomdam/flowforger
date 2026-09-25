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

  it('Response with a connector trigger → RESPONSE_TRIGGER error naming the connector', () => {
    const r = validateFlowIR(makeIR([response('Respond')], connectorTrigger));
    const e = codes(r, 'RESPONSE_TRIGGER');
    assert.equal(e.length, 1);
    assert.match(e[0].message, /sharepoint GetOnNewItems/);
  });

  it('Response with a manual (button / PowerAppV2) trigger → no RESPONSE_TRIGGER', () => {
    const manual = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'manual', inputs: { triggerKind: 'PowerAppV2' } };
    const r = validateFlowIR(makeIR([response('Respond', { inputs: { statusCode: 200, kind: 'PowerApp' } })], manual));
    assert.deepEqual(codes(r, 'RESPONSE_TRIGGER'), []);
  });

  it('Response in a fan-out parallel branch → RESPONSE_PARALLEL warning', () => {
    // A auto-chains after GetData; Respond explicitly runs after GetData too → parallel with A
    const r = validateFlowIR(makeIR([
      compose('GetData'),
      compose('A'),
      response('Respond', { runAfter: { GetData: ['Succeeded'] } }),
    ]));
    const w = codes(r, 'RESPONSE_PARALLEL');
    assert.equal(w.length, 1);
    assert.equal(w[0].level, 'warning');
    assert.match(w[0].message, /'Respond'.*'A' both run after 'GetData' \(succeeded\)/);
    assert.equal(r.ok, true, 'a warning does not fail validation');
  });

  it('two Responses after the same scope on disjoint statuses (try/catch) → no RESPONSE_PARALLEL', () => {
    const r = validateFlowIR(makeIR([
      scope('Try', [compose('Work')]),
      response('Respond_OK', { runAfter: { Try: ['Succeeded'] } }),
      response('Respond_Error', { runAfter: { Try: ['Failed', 'TimedOut'] } }),
    ]));
    assert.deepEqual(codes(r, 'RESPONSE_PARALLEL'), []);
  });

  it('Response that joins the branches (runAfter both) → no RESPONSE_PARALLEL', () => {
    const r = validateFlowIR(makeIR([
      compose('GetData'),
      compose('A', { runAfter: { GetData: ['Succeeded'] } }),
      compose('B', { runAfter: { GetData: ['Succeeded'] } }),
      response('Respond', { runAfter: { A: ['Succeeded'], B: ['Succeeded'] } }),
    ]));
    assert.deepEqual(codes(r, 'RESPONSE_PARALLEL'), []);
  });

  it('actions nested deeper than 8 levels → NESTING_DEPTH warning', () => {
    let inner: any[] = [compose('Deep')];
    for (let i = 8; i >= 1; i--) inner = [scope(`S${i}`, inner)];
    const r = validateFlowIR(makeIR(inner));
    const w = codes(r, 'NESTING_DEPTH');
    assert.equal(w.length, 1);
    assert.equal(w[0].level, 'warning');
    assert.equal(w[0].path, 'nodes.Deep');
    assert.match(w[0].message, /9 levels deep/);
  });

  it('actions nested exactly 8 levels → no NESTING_DEPTH', () => {
    let inner: any[] = [compose('Deep')];
    for (let i = 7; i >= 1; i--) inner = [scope(`S${i}`, inner)];
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
    assert.match(e[0].message, /'Recurrence' trigger \("manual"\)/);
  });

  it('Response with an OpenApiConnection trigger → RESPONSE_TRIGGER naming the operation', () => {
    const trigger = { type: 'OpenApiConnection', inputs: { host: { operationId: 'GetOnNewItems' } } };
    const r = validateLogicApps(makeLA({ Respond: laResponse() }, trigger));
    const e = codes(r, 'RESPONSE_TRIGGER');
    assert.equal(e.length, 1);
    assert.match(e[0].message, /GetOnNewItems/);
  });

  it('Response with a Request trigger of kind PowerApp → no RESPONSE_TRIGGER', () => {
    const r = validateLogicApps(makeLA({ Respond: laResponse() }, { type: 'Request', kind: 'PowerAppV2', inputs: {} }));
    assert.deepEqual(codes(r, 'RESPONSE_TRIGGER'), []);
  });

  it('Response in a parallel branch → RESPONSE_PARALLEL warning; disjoint statuses → none', () => {
    const parallel = validateLogicApps(makeLA({
      GetData: laCompose(),
      A: laCompose({ GetData: ['Succeeded'] }),
      Respond: laResponse({ GetData: ['Succeeded'] }),
    }));
    assert.equal(codes(parallel, 'RESPONSE_PARALLEL').length, 1);
    assert.equal(parallel.ok, true);

    const tryCatch = validateLogicApps(makeLA({
      Try: laScope({ Work: laCompose() }),
      Respond_OK: laResponse({ Try: ['Succeeded'] }),
      Respond_Error: laResponse({ Try: ['Failed', 'TimedOut'] }),
    }));
    assert.deepEqual(codes(tryCatch, 'RESPONSE_PARALLEL'), []);
  });

  it('InitializeVariable inside a Scope → VAR_INIT_NESTED error', () => {
    const r = validateLogicApps(makeLA({
      Init_ok: { type: 'InitializeVariable', inputs: { variables: [{ name: 'a', type: 'integer' }] }, runAfter: {} },
      Wrap: laScope({ Init_nested: { type: 'InitializeVariable', inputs: { variables: [{ name: 'b', type: 'integer' }] }, runAfter: {} } }),
    }));
    assert.deepEqual(codes(r, 'VAR_INIT_NESTED').map((i) => i.path), ['definition.actions.Wrap.actions.Init_nested']);
  });

  it('actions nested deeper than 8 levels → NESTING_DEPTH warning', () => {
    let inner: Record<string, any> = { Deep: laCompose() };
    for (let i = 8; i >= 1; i--) inner = { [`S${i}`]: laScope(inner) };
    const r = validateLogicApps(makeLA(inner));
    const w = codes(r, 'NESTING_DEPTH');
    assert.equal(w.length, 1);
    assert.match(w[0].path!, /\.Deep$/);
  });
});
