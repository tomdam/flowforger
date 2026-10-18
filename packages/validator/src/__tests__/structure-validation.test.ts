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

  it('until: empty body → UNTIL_EMPTY, count > 5000 → UNTIL_COUNT, bad timeout → UNTIL_TIMEOUT, all warnings (the cloud saves them)', () => {
    const r = validateFlowIR(makeIR([dountil('Poll', [], { limit: 6000, timeout: '1 hour' })]));
    assert.equal(codes(r, 'UNTIL_EMPTY').length, 1);
    assert.equal(codes(r, 'UNTIL_COUNT').length, 1);
    assert.equal(codes(r, 'UNTIL_TIMEOUT').length, 1);
    assert.deepEqual(r.issues.filter((i) => i.code.startsWith('UNTIL_')).map((i) => i.level), ['warning', 'warning', 'warning']);
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
    // Measured in conformance/save-rules/structure.mjs: the cloud saves an undefined parameter and
    // item() outside a loop, and rejects an undefined variable.
    assert.equal(codes(r, 'EXPR_UNKNOWN_PARAMETER').length, 1);
    assert.equal(codes(r, 'EXPR_UNKNOWN_PARAMETER')[0].level, 'warning');
    assert.equal(loops.find((i) => i.message.includes('item()')), undefined);
    assert.equal(codes(r, 'VARIABLE_UNDEFINED').length, 1);
    assert.equal(codes(r, 'VARIABLE_UNDEFINED')[0].level, 'error');
  });

  it('item() outside a foreach → EXPR_LOOP_REFERENCE; parameters are not checked when the IR has none', () => {
    const r = validateFlowIR(makeIR([compose('A', "@item()?['x']"), compose('B', "@parameters('Anything')")]));
    assert.equal(codes(r, 'EXPR_LOOP_REFERENCE').length, 1);
    assert.equal(codes(r, 'EXPR_UNKNOWN_PARAMETER').length, 0);
  });

  it('Set variable on an uninitialized variable → VARIABLE_UNINITIALIZED error', () => {
    const r = validateFlowIR(makeIR([setVar('ghost')]));
    assert.equal(codes(r, 'VARIABLE_UNINITIALIZED').length, 1);
    assert.equal(codes(r, 'VARIABLE_UNINITIALIZED')[0].level, 'error');
  });

  it("expression longer than 8192 characters (without the '@') → EXPR_LENGTH error", () => {
    const exact = `@concat('${'x'.repeat(LIMITS.expressionLength - 10)}')`; // 8192 after the '@'
    assert.equal(codes(validateFlowIR(makeIR([compose('A', exact)])), 'EXPR_LENGTH').length, 0);
    const over = `@concat('${'x'.repeat(LIMITS.expressionLength - 9)}')`;
    const e = codes(validateFlowIR(makeIR([compose('A', over)])), 'EXPR_LENGTH');
    assert.equal(e.length, 1);
    assert.equal(e[0].level, 'error');
  });

  it('a variable initialized twice (case-insensitively) → VAR_INIT_DUPLICATE', () => {
    const r = validateFlowIR(makeIR([initVar('n'), initVar('N')]));
    assert.equal(codes(r, 'VAR_INIT_DUPLICATE').length, 1);
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

  it("a 'not' with a string operand in an If condition → CONDITION_NOT_STRING (the cloud rejects it on save)", () => {
    const cond = (expression: any) => ({ type: 'If', expression, actions: {}, else: { actions: {} }, runAfter: {} });
    const bad = validateLogicApps(makeLA({ C: cond({ and: [{ not: "@empty(variables('v'))" }] }) }));
    const e = codes(bad, 'CONDITION_NOT_STRING');
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'definition.actions.C.expression.and[0].not');
    assert.match(e[0].message, /equals/);
    const fine = validateLogicApps(makeLA({
      A: cond({ and: [{ not: { equals: ["@variables('v')", 'x'] } }] }),
      B: cond("@empty(variables('v'))"),
      D: cond({ or: ["@empty(variables('v'))", { equals: ["@variables('v')", 'x'] }] }),
      E: cond({ and: [{ equals: ["@not(empty(variables('v')))", true] }] }),
    }));
    assert.equal(codes(fine, 'CONDITION_NOT_STRING').length, 0);
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
    // The cap is a 500-day period: Minute 720000 is the last accepted interval.
    const ok = validateLogicApps(makeLA({ A: laCompose() }, { trigger: { type: 'Recurrence', recurrence: { frequency: 'Minute', interval: 720000 } } }));
    assert.equal(codes(ok, 'RECURRENCE').length, 0);
    const r = validateLogicApps(makeLA({ A: laCompose() }, { trigger: { type: 'Recurrence', recurrence: { frequency: 'Minute', interval: 720001 } } }));
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

describe('runAfter reachability (RUNAFTER_DEAD_STATUS / RUNAFTER_UNSATISFIABLE)', () => {
  const tryCatch = () => [
    scope('Try', [compose('Risky')]),
    { ...scope('Catch', [compose('Error')]), runAfter: { Try: ['Failed'] } },
  ];

  it('a status that contradicts the other ANDed dependencies → RUNAFTER_DEAD_STATUS (warning)', () => {
    const r = validateFlowIR(makeIR([
      ...tryCatch(),
      compose('Resolve', 1, { runAfter: { Catch: ['Succeeded', 'Skipped'], Try: ['Succeeded'] } }),
    ]));
    const dead = codes(r, 'RUNAFTER_DEAD_STATUS');
    assert.equal(dead.length, 1);
    assert.equal(dead[0].level, 'warning');
    assert.equal(dead[0].path, 'nodes.Resolve');
    assert.match(dead[0].message, /'Resolve' runs after 'Catch': Succeeded, but 'Catch' can never be Succeeded while/);
    assert.match(dead[0].message, /'Try': Succeeded/);
    assert.equal(codes(r, 'RUNAFTER_UNSATISFIABLE').length, 0);
  });

  it('no combination of statuses runs the action → RUNAFTER_UNSATISFIABLE, without per-status noise', () => {
    const r = validateFlowIR(makeIR([
      ...tryCatch(),
      compose('Response', 1, { runAfter: { Try: ['Succeeded'], Catch: ['Succeeded'] } }),
    ]));
    const unsat = codes(r, 'RUNAFTER_UNSATISFIABLE');
    assert.equal(unsat.length, 1);
    assert.equal(unsat[0].level, 'warning');
    assert.match(unsat[0].message, /'Response' can never run/);
    assert.match(unsat[0].message, /ANDed/);
    assert.equal(codes(r, 'RUNAFTER_DEAD_STATUS').length, 0);
  });

  it('a single dependency covering both paths, and a Finally scope, are clean', () => {
    const r1 = validateFlowIR(makeIR([...tryCatch(), compose('Response', 1, { runAfter: { Catch: ['Succeeded', 'Skipped'] } })]));
    assert.equal(codes(r1, 'RUNAFTER_DEAD_STATUS').length + codes(r1, 'RUNAFTER_UNSATISFIABLE').length, 0);
    const r2 = validateFlowIR(makeIR([
      ...tryCatch(),
      { ...scope('Finally', [compose('Cleanup')]), runAfter: { Try: ['Succeeded', 'Failed', 'Skipped'] } },
      compose('Response'),
    ]));
    // 'Skipped' can never hold for Try (it starts the flow) but that is harmless over-listing, not a contradiction.
    assert.equal(codes(r2, 'RUNAFTER_DEAD_STATUS').length + codes(r2, 'RUNAFTER_UNSATISFIABLE').length, 0);
  });

  it('a fan-in of parallel branches is clean', () => {
    const r = validateFlowIR(makeIR([
      compose('A'),
      compose('B', 1, { runAfter: {} }),
      compose('Join', 1, { runAfter: { A: ['Succeeded'], B: ['Succeeded'] } }),
    ]));
    assert.equal(codes(r, 'RUNAFTER_DEAD_STATUS').length + codes(r, 'RUNAFTER_UNSATISFIABLE').length, 0);
  });

  it('a dead status is found through an implicit (sequential) predecessor and in nested groups', () => {
    const r = validateFlowIR(makeIR([
      scope('Outer', [
        ...tryCatch(),
        compose('Notify'), // implicit: after Catch Succeeded
        compose('Resolve', 1, { runAfter: { Notify: ['Succeeded', 'Skipped'], Try: ['Succeeded'] } }),
      ]),
    ]));
    const dead = codes(r, 'RUNAFTER_DEAD_STATUS');
    assert.equal(dead.length, 1);
    assert.match(dead[0].message, /'Notify': Succeeded/);
  });

  it('the same rule runs on Logic Apps JSON', () => {
    const laCompose = (inputs: any = 1, runAfter: any = {}) => ({ type: 'Compose', inputs, runAfter });
    const makeLA = (actions: Record<string, any>) => ({
      properties: { definition: { $schema: 'x', contentVersion: '1.0.0.0', triggers: { manual: { type: 'Request', kind: 'Http', inputs: {} } }, actions } },
    });
    const r = validateLogicApps(makeLA({
      Try: { type: 'Scope', actions: { Risky: laCompose() }, runAfter: {} },
      Catch: { type: 'Scope', actions: { Error: laCompose() }, runAfter: { Try: ['Failed'] } },
      Resolve: laCompose(1, { Catch: ['Succeeded', 'Skipped'], Try: ['Succeeded'] }),
    }));
    assert.equal(codes(r, 'RUNAFTER_DEAD_STATUS').length, 1);
  });
});


describe('RUNAFTER_SKIPPED_ON_SUCCESS (no Response on the all-success path)', () => {
  const response = (name: string, extra: any = {}) => ({ id: `act_${name}`, type: 'action', name, kind: 'response', inputs: { statusCode: 200, body: {} }, ...extra });
  const tryCatch = (catchActions: any[] = [compose('Note_error')]) => [
    scope('Try', [compose('Risky')]),
    { ...scope('Catch', catchActions), runAfter: { Try: ['Failed'] } },
  ];

  it('a Response chained after a catch scope → warning', () => {
    const r = validateFlowIR(makeIR([...tryCatch(), response('Respond')]));
    const w = codes(r, 'RUNAFTER_SKIPPED_ON_SUCCESS');
    assert.equal(w.length, 1);
    assert.equal(w[0].level, 'warning');
    assert.match(w[0].message, /'Respond' runs after 'Catch': Succeeded/);
    assert.equal(w[0].path, 'nodes.Respond');
  });

  it('a Finally scope before the Response → no warning', () => {
    const finallyScope = { ...scope('Finally', [compose('Cleanup')]), runAfter: { Try: ['Succeeded', 'Failed', 'Skipped'] } };
    const r = validateFlowIR(makeIR([...tryCatch(), finallyScope, response('Respond')]));
    assert.equal(codes(r, 'RUNAFTER_SKIPPED_ON_SUCCESS').length, 0);
  });

  it('runAfter Catch: Succeeded, Skipped → no warning', () => {
    const r = validateFlowIR(makeIR([...tryCatch(), response('Respond', { runAfter: { Catch: ['Succeeded', 'Skipped'] } })]));
    assert.equal(codes(r, 'RUNAFTER_SKIPPED_ON_SUCCESS').length, 0);
  });

  it('a Response in Try and another in Catch → no warning (one runs on success)', () => {
    const nodes = [
      scope('Try', [compose('Risky'), response('Respond_ok')]),
      { ...scope('Catch', [response('Respond_error', { inputs: { statusCode: 500, body: {} } })]), runAfter: { Try: ['Failed'] } },
    ];
    assert.equal(codes(validateFlowIR(makeIR(nodes)), 'RUNAFTER_SKIPPED_ON_SUCCESS').length, 0);
  });

  it('a Response inside an if branch may run → no warning', () => {
    const ifNode = { id: 'if_1', type: 'if', name: 'Check', condition: "@equals(outputs('A'), 1)", actions: [response('Respond')], elseActions: [] };
    assert.equal(codes(validateFlowIR(makeIR([compose('A'), ifNode])), 'RUNAFTER_SKIPPED_ON_SUCCESS').length, 0);
  });

  it('a Response nested in a block chained after the catch → warning (the block is skipped on success)', () => {
    const r = validateFlowIR(makeIR([...tryCatch(), scope('Answer', [response('Respond')])]));
    assert.equal(codes(r, 'RUNAFTER_SKIPPED_ON_SUCCESS').length, 1);
  });

  it('a flow without a Response → nothing', () => {
    assert.equal(codes(validateFlowIR(makeIR([...tryCatch(), compose('Send_error_mail')])), 'RUNAFTER_SKIPPED_ON_SUCCESS').length, 0);
  });

  it('Logic Apps JSON: a Response after the catch scope → warning', () => {
    const def = {
      triggers: { manual: { type: 'Request', kind: 'Http', inputs: {} } },
      actions: {
        Try: { type: 'Scope', runAfter: {}, actions: { Risky: { type: 'Compose', runAfter: {}, inputs: 1 } } },
        Catch: { type: 'Scope', runAfter: { Try: ['Failed'] }, actions: { Note: { type: 'Compose', runAfter: {}, inputs: 1 } } },
        Respond: { type: 'Response', kind: 'Http', runAfter: { Catch: ['Succeeded'] }, inputs: { statusCode: 200, body: {} } },
      },
    };
    const r = validateLogicApps({ properties: { definition: def, connectionReferences: {} } });
    assert.equal(codes(r, 'RUNAFTER_SKIPPED_ON_SUCCESS').length, 1);
  });
});

describe('DV_LOOKUP_UNGUARDED (Dataverse Get a row by an optional lookup)', () => {
  const dvGet = (name: string, recordId: string) => ({ id: `con_${name}`, type: 'connector', name, connector: 'dataverse', operation: 'GetItem', params: { entityName: 'cr_programs', recordId } });
  const getPeriod = dvGet('Get_Period', "@triggerBody()?['periodId']");
  const ifNode = (name: string, condition: string, actions: any[], elseActions: any[] = []) => ({ id: `if_${name}`, type: 'if', name, condition, actions, elseActions });

  it('recordId from a lookup column of another action, unguarded → info', () => {
    const r = validateFlowIR(makeIR([getPeriod, dvGet('Get_Program', "@body('Get_Period')?['_cr_program_value']")]));
    const i = codes(r, 'DV_LOOKUP_UNGUARDED');
    assert.equal(i.length, 1);
    assert.equal(i[0].level, 'info');
    assert.match(i[0].message, /'Get_Program' gets a row by the lookup column '_cr_program_value' of 'Get_Period'/);
    assert.equal(i[0].path, 'nodes.Get_Program');
    assert.equal(codes(r, 'DV_LOOKUP_UNGUARDED').some((x) => x.path === 'nodes.Get_Period'), false, 'a trigger value is not a lookup read');
  });

  it('inside an if whose condition mentions the same column of the same action → nothing (then or else branch)', () => {
    const guarded = ifNode('Has_program', "@not(empty(body('Get_Period')?['_cr_program_value']))", [dvGet('Get_Program', "@body('Get_Period')?['_cr_program_value']")]);
    assert.equal(codes(validateFlowIR(makeIR([getPeriod, guarded])), 'DV_LOOKUP_UNGUARDED').length, 0);
    const inElse = ifNode('No_program', "@empty(body('Get_Period')?['_cr_program_value'])", [compose('None')], [dvGet('Get_Program', "@body('Get_Period')?['_cr_program_value']")]);
    assert.equal(codes(validateFlowIR(makeIR([getPeriod, inElse])), 'DV_LOOKUP_UNGUARDED').length, 0);
  });

  it('an enclosing if on another column or another action does not count as the guard', () => {
    const otherColumn = ifNode('Has_broker', "@empty(body('Get_Period')?['_cr_broker_value'])", [dvGet('Get_Program', "@body('Get_Period')?['_cr_program_value']")]);
    assert.equal(codes(validateFlowIR(makeIR([getPeriod, otherColumn])), 'DV_LOOKUP_UNGUARDED').length, 1);
    const otherAction = ifNode('Check', "@not(empty(outputs('Other')?['_cr_program_value']))", [dvGet('Get_Program', "@body('Get_Period')?['_cr_program_value']")]);
    assert.equal(codes(validateFlowIR(makeIR([getPeriod, compose('Other'), otherAction])), 'DV_LOOKUP_UNGUARDED').length, 1);
  });

  it('a guard anywhere up the block chain counts, and the Customer lookuplogicalname check counts', () => {
    const inner = scope('Work', [dvGet('Get_Program', "@body('Get_Period')?['_cr_program_value']")]);
    const outer = ifNode('Has_program', "@not(empty(body('Get_Period')?['_cr_program_value']))", [inner]);
    assert.equal(codes(validateFlowIR(makeIR([getPeriod, outer])), 'DV_LOOKUP_UNGUARDED').length, 0);
    const customer = ifNode('Is_account', "@equals(body('Get_Period')?['_cr_customer_value@Microsoft.Dynamics.CRM.lookuplogicalname'], 'account')",
      [dvGet('Get_Account', "@body('Get_Period')?['_cr_customer_value']")], [dvGet('Get_Contact', "@body('Get_Period')?['_cr_customer_value']")]);
    assert.equal(codes(validateFlowIR(makeIR([getPeriod, customer])), 'DV_LOOKUP_UNGUARDED').length, 0);
  });

  it('a recordId that is not a lookup read, and other operations, are left alone', () => {
    const nodes = [
      getPeriod,
      compose('Broker_id', "@body('Get_Period')?['_cr_broker_value']"),
      dvGet('Get_Broker', "@outputs('Broker_id')"),
      { id: 'con_List', type: 'connector', name: 'List', connector: 'dataverse', operation: 'ListRecords', params: { entityName: 'contacts', $filter: "_cr_program_value eq '@{body('Get_Period')?['_cr_program_value']}'" } },
      { id: 'con_Sp', type: 'connector', name: 'Sp', connector: 'sharepoint', operation: 'GetItem', params: { dataset: 'x', table: 'y', id: "@body('Get_Period')?['_cr_program_value']" } },
    ];
    assert.equal(codes(validateFlowIR(makeIR(nodes)), 'DV_LOOKUP_UNGUARDED').length, 0);
  });

  it('Logic Apps JSON: the designer form outputs(...)?[body/_x_value] is recognised, guarded or not', () => {
    const get = (recordId: string) => ({
      type: 'OpenApiConnection', runAfter: {},
      inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', operationId: 'GetItem', connectionName: 'shared_commondataserviceforapps' }, parameters: { entityName: 'cr_programs', recordId } },
    });
    const period = get("@triggerBody()?['periodId']");
    const unguarded = { triggers: { manual: { type: 'Request', kind: 'Http', inputs: {} } }, actions: { Get_Period: period, Get_Program: { ...get("@outputs('Get_Period')?['body/_cr_program_value']"), runAfter: { Get_Period: ['Succeeded'] } } } };
    const r1 = validateLogicApps({ properties: { definition: unguarded, connectionReferences: { shared_commondataserviceforapps: {} } } });
    assert.equal(codes(r1, 'DV_LOOKUP_UNGUARDED').length, 1);
    const guarded = {
      ...unguarded,
      actions: {
        Get_Period: period,
        Has_program: {
          type: 'If', runAfter: { Get_Period: ['Succeeded'] },
          expression: { and: [{ not: { equals: ["@empty(outputs('Get_Period')?['body/_cr_program_value'])", true] } }] },
          actions: { Get_Program: get("@outputs('Get_Period')?['body/_cr_program_value']") }, else: { actions: {} },
        },
      },
    };
    const r2 = validateLogicApps({ properties: { definition: guarded, connectionReferences: { shared_commondataserviceforapps: {} } } });
    assert.equal(codes(r2, 'DV_LOOKUP_UNGUARDED').length, 0);
  });
});
