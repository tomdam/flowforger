import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlowIR, validateLogicApps, parseIsoDurationMs, LIMITS, type ValidationIssue } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

const httpTrigger = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'http', inputs: {} };
function makeIR(nodes: any[], extra: Partial<FlowIR> = {}, trigger: any = httpTrigger): FlowIR {
  return { name: 'TestFlow', nodes: [trigger, ...nodes], ...extra } as unknown as FlowIR;
}
const compose = (name: string, value: any = 1, extra: any = {}) => ({ id: `act_${name}`, type: 'action', name, kind: 'compose', inputs: { value }, ...extra });
const initVar = (name: string, variableType = 'Integer') => ({ id: `act_Init_${name}`, type: 'action', name: `Init_${name}`, kind: 'initializevariable', inputs: { variableName: name, variableType, value: 0 } });
const setVar = (name: string, value: any = 1) => ({ id: `act_Set_${name}`, type: 'action', name: `Set_${name}`, kind: 'setvariable', inputs: { name, value } });
const foreach = (name: string, actions: any[], extra: any = {}) => ({ id: `fe_${name}`, type: 'foreach', name, itemsExpression: '@createArray(1)', actions, ...extra });
const dountil = (name: string, actions: any[], extra: any = {}) => ({ id: `du_${name}`, type: 'dountil', name, condition: '@true', actions, ...extra });
const scope = (name: string, actions: any[]) => ({ id: `scp_${name}`, type: 'scope', name, actions });
const switchNode = (name: string, n: number) => ({ id: `sw_${name}`, type: 'switch', name, expression: '@1', cases: Array.from({ length: n }, (_, i) => ({ name: `c${i}`, value: i, actions: [] })) });

const codes = (r: { issues: ValidationIssue[] }, code: string): ValidationIssue[] => r.issues.filter((i) => i.code === code);

describe('parseIsoDurationMs', () => {
  it('parses common durations', () => {
    assert.equal(parseIsoDurationMs('PT5S'), 5_000);
    assert.equal(parseIsoDurationMs('PT1H'), 3_600_000);
    assert.equal(parseIsoDurationMs('P1D'), 86_400_000);
    assert.equal(parseIsoDurationMs('P1DT2H30M'), 86_400_000 + 2 * 3_600_000 + 30 * 60_000);
    assert.equal(parseIsoDurationMs('PT0.5S'), 500);
  });
  it('rejects malformed values', () => {
    for (const bad of ['1H', 'PT', 'P', '', 'PT1X', 5, null, 'PT1H1D']) assert.equal(parseIsoDurationMs(bad), undefined, String(bad));
  });
});

describe('structure rules in validateFlowIR', () => {
  it('a clean flow reports no structure issues', () => {
    const r = validateFlowIR(makeIR([initVar('n'), compose('A', "@variables('n')"), setVar('n', "@outputs('A')")]));
    const structural = r.issues.filter((i) => !['IR_ACTIONS', 'HTTP_RETRY'].includes(i.code));
    assert.deepEqual(structural, []);
  });

  it('duplicate action names across scopes, case-insensitively → ACTION_NAME_DUPLICATE', () => {
    const r = validateFlowIR(makeIR([compose('Build'), scope('S', [compose('build')])]));
    const e = codes(r, 'ACTION_NAME_DUPLICATE');
    assert.equal(e.length, 1);
    assert.match(e[0].message, /'Build' is used 2 times/);
    assert.equal(e[0].path, 'nodes.build');
  });

  it('name longer than 80 characters → ACTION_NAME_LENGTH', () => {
    const r = validateFlowIR(makeIR([compose('A'.repeat(81))]));
    assert.equal(codes(r, 'ACTION_NAME_LENGTH').length, 1);
    assert.equal(codes(validateFlowIR(makeIR([compose('A'.repeat(80))])), 'ACTION_NAME_LENGTH').length, 0);
  });

  it('more than 500 actions → ACTION_COUNT', () => {
    const r = validateFlowIR(makeIR(Array.from({ length: 501 }, (_, i) => compose(`A${i}`))));
    assert.equal(codes(r, 'ACTION_COUNT').length, 1);
  });

  it('switch with 26 cases → SWITCH_CASES; 25 is fine', () => {
    assert.equal(codes(validateFlowIR(makeIR([switchNode('Sw', 26)])), 'SWITCH_CASES').length, 1);
    assert.equal(codes(validateFlowIR(makeIR([switchNode('Sw', 25)])), 'SWITCH_CASES').length, 0);
  });

  it('more than 250 variables → VARIABLE_COUNT; bad variable type → VARIABLE_TYPE', () => {
    const many = Array.from({ length: 251 }, (_, i) => initVar(`v${i}`));
    assert.equal(codes(validateFlowIR(makeIR(many)), 'VARIABLE_COUNT').length, 1);
    const r = validateFlowIR(makeIR([initVar('x', 'Number')]));
    assert.match(codes(r, 'VARIABLE_TYPE')[0].message, /'Number'/);
  });

  it('foreach concurrency outside 1-50 → FOREACH_CONCURRENCY', () => {
    const bad = foreach('Each', [], { runtimeConfiguration: { concurrency: { repetitions: 51 } } });
    const ok = foreach('Each', [], { runtimeConfiguration: { concurrency: { repetitions: 50 } } });
    assert.equal(codes(validateFlowIR(makeIR([bad])), 'FOREACH_CONCURRENCY').length, 1);
    assert.equal(codes(validateFlowIR(makeIR([ok])), 'FOREACH_CONCURRENCY').length, 0);
  });

  it('trigger concurrency outside 1-100 → TRIGGER_CONCURRENCY', () => {
    const trig = { ...httpTrigger, runtimeConfiguration: { concurrency: { runs: 0 } } };
    assert.equal(codes(validateFlowIR(makeIR([compose('A')], {}, trig)), 'TRIGGER_CONCURRENCY').length, 1);
  });

  it('until: empty body → UNTIL_EMPTY, count > 5000 → UNTIL_COUNT, bad timeout → UNTIL_TIMEOUT', () => {
    const r = validateFlowIR(makeIR([dountil('Poll', [], { limit: 6000, timeout: '1 hour' })]));
    assert.equal(codes(r, 'UNTIL_EMPTY').length, 1);
    assert.equal(codes(r, 'UNTIL_COUNT').length, 1);
    assert.equal(codes(r, 'UNTIL_TIMEOUT').length, 1);
    assert.equal(codes(r, 'UNTIL_TIMEOUT')[0].level, 'warning');
    const ok = validateFlowIR(makeIR([dountil('Poll', [compose('A')], { limit: 100, timeout: 'PT2H' })]));
    assert.deepEqual(ok.issues.filter((i) => i.code.startsWith('UNTIL_')), []);
  });

  it('terminate with an invalid status → TERMINATE_STATUS', () => {
    const t = { id: 'act_T', type: 'action', name: 'T', kind: 'terminate', inputs: { runStatus: 'Done' } };
    assert.equal(codes(validateFlowIR(makeIR([t])), 'TERMINATE_STATUS').length, 1);
  });

  it('PowerApp response with an HTTP trigger → RESPONSE_KIND warning; with a manual trigger → fine', () => {
    const resp = { id: 'act_R', type: 'action', name: 'R', kind: 'response', inputs: { statusCode: 200, kind: 'PowerApp' } };
    const w = codes(validateFlowIR(makeIR([resp])), 'RESPONSE_KIND');
    assert.equal(w.length, 1);
    assert.equal(w[0].level, 'warning');
    const manual = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'manual', inputs: { triggerKind: 'PowerAppV2' } };
    assert.equal(codes(validateFlowIR(makeIR([resp], {}, manual)), 'RESPONSE_KIND').length, 0);
    const button = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'manual', inputs: {} };
    assert.equal(codes(validateFlowIR(makeIR([resp], {}, button)), 'RESPONSE_KIND').length, 0);
  });

  it('retry policy: bad type, count and interval → RETRY_POLICY', () => {
    const r = validateFlowIR(makeIR([
      compose('A', 1, { retryPolicy: { type: 'linear' } }),
      compose('B', 1, { retryPolicy: { type: 'fixed', count: 91, interval: 'PT20S' } }),
      compose('C', 1, { retryPolicy: { type: 'fixed', count: 3, interval: 'PT2S' } }),
      compose('D', 1, { retryPolicy: { type: 'exponential', count: 3, interval: 'twenty' } }),
      compose('E', 1, { retryPolicy: { type: 'none' } }),
      compose('F', 1, { retryPolicy: { type: 'Fixed', count: 90, interval: 'P1D' } }),
    ]));
    const e = codes(r, 'RETRY_POLICY');
    assert.deepEqual(e.map((i) => i.path), ['nodes.A', 'nodes.B', 'nodes.C', 'nodes.D']);
  });

  it('recurrence: bad frequency/interval → RECURRENCE, schedule mismatch → RECURRENCE_SCHEDULE', () => {
    const rec = (inputs: any) => ({ id: 'trg_1', type: 'recurrence', name: 'Recurrence', inputs });
    assert.equal(codes(validateFlowIR(makeIR([compose('A')], {}, rec({ frequency: 'Fortnight', interval: 1 }))), 'RECURRENCE').length, 1);
    assert.equal(codes(validateFlowIR(makeIR([compose('A')], {}, rec({ frequency: 'Day', interval: 501 }))), 'RECURRENCE').length, 1);
    assert.equal(codes(validateFlowIR(makeIR([compose('A')], {}, rec({ frequency: 'Day', interval: 0 }))), 'RECURRENCE').length, 1);
    assert.equal(codes(validateFlowIR(makeIR([compose('A')], {}, rec({ frequency: 'Hour', interval: 1, schedule: { weekDays: ['Monday'] } }))), 'RECURRENCE_SCHEDULE').length, 1);
    const ok = validateFlowIR(makeIR([compose('A')], {}, rec({ frequency: 'Week', interval: 1, schedule: { hours: [8], minutes: [0], weekDays: ['Monday'] }, startTime: '2026-01-01T08:00:00Z' })));
    assert.deepEqual(ok.issues.filter((i) => i.code.startsWith('RECURRENCE')), []);
  });

  it('runAfter: unknown sibling, non-sibling, bad status, self, cycle', () => {
    const r = validateFlowIR(makeIR([
      scope('Try', [compose('Inner')]),
      compose('A', 1, { runAfter: { Nope: ['Succeeded'] } }),
      compose('B', 1, { runAfter: { Inner: ['Succeeded'] } }),
      compose('C', 1, { runAfter: { Try: ['Done'] } }),
      compose('D', 1, { runAfter: { D: ['Succeeded'] } }),
      compose('E', 1, { runAfter: { F: ['Succeeded'] } }),
      compose('F', 1, { runAfter: { E: ['Succeeded'] } }),
    ]));
    assert.match(codes(r, 'RUNAFTER_UNKNOWN')[0].message, /'Nope'.*no such action/);
    assert.match(codes(r, 'RUNAFTER_UNKNOWN')[1].message, /'Inner'.*exists at nodes\.Inner, but runAfter can only reference siblings/);
    assert.equal(codes(r, 'RUNAFTER_STATUS').length, 1);
    assert.equal(codes(r, 'RUNAFTER_SELF').length, 1);
    assert.match(codes(r, 'RUNAFTER_CYCLE')[0].message, /E → F → E|F → E → F/);
  });

  it('expression references: unknown action, loop, parameter, variable', () => {
    const r = validateFlowIR(makeIR([
      initVar('n'),
      compose('A', "@outputs('Missing')"),
      compose('B', "@items('Each')"),
      foreach('Each', [compose('C', "@items('Other')"), compose('D', '@item()')]),
      compose('E', "@parameters('Site')"),
      compose('F', "@variables('ghost')"),
      compose('G', "@{body('A')} and @{parameters('$connections')}"),
    ], { parameters: { Other: { type: 'String' } } } as any));
    assert.match(codes(r, 'EXPR_UNKNOWN_ACTION')[0].message, /outputs\('Missing'\)/);
    assert.equal(codes(r, 'EXPR_UNKNOWN_ACTION').length, 1);
    const loops = codes(r, 'EXPR_LOOP_REFERENCE');
    assert.deepEqual(loops.map((i) => i.path), ['nodes.B.value', 'nodes.C.value']);
    assert.match(loops[0].message, /does not enclose/);
    assert.match(loops[1].message, /no such loop/);
    assert.equal(codes(r, 'EXPR_UNKNOWN_PARAMETER').length, 1);
    assert.equal(codes(r, 'VARIABLE_UNDEFINED').length, 1);
    assert.equal(codes(r, 'VARIABLE_UNDEFINED')[0].level, 'warning');
  });

  it('item() outside a foreach → EXPR_LOOP_REFERENCE; parameters are not checked when the IR has none', () => {
    const r = validateFlowIR(makeIR([compose('A', "@item()?['x']"), compose('B', "@parameters('Anything')")]));
    assert.equal(codes(r, 'EXPR_LOOP_REFERENCE').length, 1);
    assert.equal(codes(r, 'EXPR_UNKNOWN_PARAMETER').length, 0);
  });

  it('Set variable on an uninitialized variable → VARIABLE_UNINITIALIZED warning', () => {
    const r = validateFlowIR(makeIR([setVar('ghost')]));
    assert.equal(codes(r, 'VARIABLE_UNINITIALIZED').length, 1);
  });

  it('expression longer than 8192 characters → EXPR_LENGTH warning', () => {
    const r = validateFlowIR(makeIR([compose('A', `@concat('${'x'.repeat(LIMITS.expressionLength)}')`)]));
    assert.equal(codes(r, 'EXPR_LENGTH').length, 1);
  });
});

describe('structure rules in validateLogicApps', () => {
  const laCompose = (inputs: any = 1, runAfter: any = {}) => ({ type: 'Compose', inputs, runAfter });
  function makeLA(actions: Record<string, any>, opts: { trigger?: any; parameters?: any; connectionReferences?: any } = {}) {
    const definition: any = {
      $schema: 'x', contentVersion: '1.0.0.0',
      triggers: { manual: opts.trigger ?? { type: 'Request', kind: 'Http', inputs: {} } },
      actions,
    };
    if (opts.parameters) definition.parameters = opts.parameters;
    return opts.connectionReferences ? { properties: { definition, connectionReferences: opts.connectionReferences } } : { definition };
  }

  it('a clean Power Automate clientdata reports no structure issues', () => {
    const r = validateLogicApps(makeLA({
      Init: { type: 'InitializeVariable', inputs: { variables: [{ name: 'n', type: 'integer', value: 0 }] }, runAfter: {} },
      Get: { type: 'OpenApiConnection', inputs: { host: { connectionName: 'shared_sharepointonline', operationId: 'GetItems', apiId: '/x' }, parameters: {}, authentication: "@parameters('$authentication')" }, runAfter: { Init: ['Succeeded'] } },
      Set: { type: 'SetVariable', inputs: { name: 'n', value: "@length(outputs('Get')?['body/value'])" }, runAfter: { Get: ['Succeeded'] } },
    }, { parameters: { $connections: { type: 'Object' }, $authentication: { type: 'SecureObject' } }, connectionReferences: { shared_sharepointonline: {} } }));
    assert.deepEqual(r.issues, []);
  });

  it('more than one trigger → TRIGGER_COUNT', () => {
    const doc = makeLA({ A: laCompose() });
    (doc as any).definition.triggers.second = { type: 'Recurrence', recurrence: { frequency: 'Day', interval: 1 } };
    assert.equal(codes(validateLogicApps(doc), 'TRIGGER_COUNT').length, 1);
  });

  it('connection reference not in connectionReferences → CONNECTION_REF_MISSING; skipped when the doc has none', () => {
    const action = { type: 'OpenApiConnection', inputs: { host: { connectionName: 'shared_teams', operationId: 'PostMessage' } }, runAfter: {} };
    const r = validateLogicApps(makeLA({ Post: action }, { connectionReferences: { shared_sharepointonline: {} } }));
    assert.match(codes(r, 'CONNECTION_REF_MISSING')[0].message, /'shared_teams'.*shared_sharepointonline/);
    assert.equal(codes(validateLogicApps(makeLA({ Post: action })), 'CONNECTION_REF_MISSING').length, 0);
  });

  it('until without limit → UNTIL_LIMIT; terminate runError with Succeeded → TERMINATE_RUNERROR', () => {
    const r = validateLogicApps(makeLA({
      Poll: { type: 'Until', expression: '@true', actions: { X: laCompose() }, runAfter: {} },
      End: { type: 'Terminate', inputs: { runStatus: 'Succeeded', runError: { code: 'x' } }, runAfter: { Poll: ['Succeeded'] } },
    }));
    assert.equal(codes(r, 'UNTIL_LIMIT').length, 1);
    assert.equal(codes(r, 'TERMINATE_RUNERROR').length, 1);
  });

  it('runAfter referencing an action in another scope → RUNAFTER_UNKNOWN with its location', () => {
    const r = validateLogicApps(makeLA({
      Try: { type: 'Scope', actions: { Inner: laCompose() }, runAfter: {} },
      After: laCompose(1, { Inner: ['Succeeded'] }),
    }));
    const e = codes(r, 'RUNAFTER_UNKNOWN');
    assert.equal(e.length, 1);
    assert.match(e[0].message, /exists at definition\.actions\.Try\.actions\.Inner/);
  });

  it('undefined parameter is an error when the definition has a parameters section', () => {
    const r = validateLogicApps(makeLA({ A: laCompose("@parameters('Site')") }, { parameters: { $connections: { type: 'Object' } } }));
    assert.equal(codes(r, 'EXPR_UNKNOWN_PARAMETER').length, 1);
    assert.equal(codes(validateLogicApps(makeLA({ A: laCompose("@parameters('Site')") })), 'EXPR_UNKNOWN_PARAMETER').length, 0);
  });

  it('items() of a non-enclosing loop and unknown outputs() → errors with JSON paths', () => {
    const r = validateLogicApps(makeLA({
      Each: { type: 'Foreach', foreach: '@createArray(1)', actions: { In: laCompose("@items('Each')") }, runAfter: {} },
      Out: laCompose("@items('Each')", { Each: ['Succeeded'] }),
      Ref: laCompose("@body('Nope')", { Out: ['Succeeded'] }),
    }));
    assert.deepEqual(codes(r, 'EXPR_LOOP_REFERENCE').map((i) => i.path), ['definition.actions.Out.inputs']);
    assert.deepEqual(codes(r, 'EXPR_UNKNOWN_ACTION').map((i) => i.path), ['definition.actions.Ref.inputs']);
  });

  it('variables per flow counts every entry of inputs.variables', () => {
    const vars = Array.from({ length: 251 }, (_, i) => ({ name: `v${i}`, type: 'string' }));
    const r = validateLogicApps(makeLA({ Init: { type: 'InitializeVariable', inputs: { variables: vars }, runAfter: {} } }));
    assert.equal(codes(r, 'VARIABLE_COUNT').length, 1);
  });

  it('recurrence trigger ranges are checked on trigger.recurrence', () => {
    const r = validateLogicApps(makeLA({ A: laCompose() }, { trigger: { type: 'Recurrence', recurrence: { frequency: 'Minute', interval: 72001 } } }));
    assert.equal(codes(r, 'RECURRENCE').length, 1);
  });

  it('VirtualAgent response with a Button trigger → RESPONSE_KIND warning', () => {
    const r = validateLogicApps(makeLA(
      { R: { type: 'Response', kind: 'VirtualAgent', inputs: { statusCode: 200 }, runAfter: {} } },
      { trigger: { type: 'Request', kind: 'Button', inputs: {} } },
    ));
    assert.equal(codes(r, 'RESPONSE_KIND').length, 1);
  });
});

describe('regressions found on the real-flow corpus', () => {
  const httpTrigger = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'http', inputs: {} };
  const ir = (nodes: any[], trigger: any = httpTrigger) => ({ name: 'T', nodes: [trigger, ...nodes] } as unknown as FlowIR);

  it('item() inside Select / Filter array / Create table refers to the current element, not a loop', () => {
    const r = validateFlowIR(ir([
      { id: 'a1', type: 'action', name: 'Pick', kind: 'select', inputs: { from: '@createArray(1)', select: { v: '@item()' } } },
      { id: 'a2', type: 'action', name: 'Keep', kind: 'filterarray', inputs: { from: '@createArray(1)', where: "@equals(item()?['x'], 1)" } },
      { id: 'a3', type: 'action', name: 'Tab', kind: 'createhtmltable', inputs: { from: '@createArray(1)', columns: [{ header: 'A', value: "@item()?['a']" }] } },
    ]));
    assert.deepEqual(r.issues.filter((i) => i.code === 'EXPR_LOOP_REFERENCE'), []);

    const la = validateLogicApps({ definition: { triggers: { manual: { type: 'Request', kind: 'Http' } }, actions: {
      Select: { type: 'Select', inputs: { from: '@createArray(1)', select: { v: '@item()' } }, runAfter: {} },
      Filter: { type: 'Query', inputs: { from: '@createArray(1)', where: "@equals(item()?['x'], 1)" }, runAfter: {} },
      Table: { type: 'Table', inputs: { from: '@createArray(1)', format: 'HTML', columns: [{ header: 'A', value: "@item()?['a']" }] }, runAfter: {} },
    } } });
    assert.deepEqual(la.issues.filter((i) => i.code === 'EXPR_LOOP_REFERENCE'), []);
  });

  it('a recurrence trigger counts as the one trigger; a connector-only flow has actions', () => {
    const recurrence = { id: 'trg_1', type: 'recurrence', name: 'Recurrence', inputs: { frequency: 'Day', interval: 1 } };
    const connector = { id: 'c1', type: 'connector', name: 'Get', connector: 'dataverse', operation: 'ListRows', params: { entityName: 'accounts' } };
    const r = validateFlowIR(ir([connector], recurrence));
    assert.deepEqual(r.issues.filter((i) => i.code === 'IR_TRIGGER' || i.code === 'IR_ACTIONS'), []);
  });
});
