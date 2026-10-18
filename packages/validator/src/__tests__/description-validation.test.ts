import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlowIR, validateLogicApps } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

// Measured by conformance/save-rules/descriptions.mjs: the cloud saves "@{...}" and a leading "@"
// in any description as is, refuses action/trigger descriptions over 256 characters, and refuses
// action names with control characters, < > % & \ ? / or "@{".

function makeIR(nodes: any[], description?: string): FlowIR {
  return {
    name: 'TestFlow',
    ...(description !== undefined ? { description } : {}),
    nodes: [
      { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'http' },
      ...nodes,
    ],
  } as unknown as FlowIR;
}

const compose = (name: string, description?: string) => ({
  id: `act_${name}`, type: 'action', name, kind: 'compose', inputs: { value: 1 }, description,
});

describe('descriptions in validateFlowIR', () => {
  it('"@{...}", a leading "@" and any length are accepted (the emitter handles length)', () => {
    const r = validateFlowIR(makeIR([
      compose('A', "Uses @{triggerBody()?['name']} for the name"),
      compose('B', '@todo check the totals'),
      compose('C', 'a'.repeat(1000)),
    ], 'Runs @{guid()} nightly'));
    assert.deepEqual(r.issues.filter(i => i.code.startsWith('DESCRIPTION_')), []);
  });
});

describe('descriptions are not expressions', () => {
  it('"@word" or invalid "@{" in an IR node note → no EXPR_ issue, also in nested branches', () => {
    const r = validateFlowIR(makeIR([
      compose('A', '@not a valid ( expression'),
      {
        id: 'if_1', type: 'if', name: 'Cond', condition: '@equals(1, 1)', description: 'see @{ for details',
        actions: [compose('T', '@todo')], elseActions: [compose('E', 'see @{} syntax')],
      },
    ]));
    assert.deepEqual(r.issues.filter(i => i.code.startsWith('EXPR_')), []);
  });

  it('a "description" inside inputs is still checked', () => {
    const r = validateLogicApps({
      definition: {
        $schema: 'x', contentVersion: '1.0.0.0',
        description: '@not a valid ( expression',
        triggers: { manual: { type: 'Request', kind: 'Http', inputs: {}, description: '@todo' } },
        actions: {
          A: { type: 'Compose', runAfter: {}, description: '@todo', inputs: { description: '@not a valid ( expression' } },
        },
      },
    });
    assert.deepEqual(r.issues.filter(i => i.code === 'EXPR_SYNTAX').map(i => i.path), ['definition.actions.A.inputs.description']);
  });
});

describe('action names', () => {
  for (const [name, part] of [
    ["B — uses @{outputs('A')}", '@{'],
    ['Send_mail\n     * Sends the summary mail', '\n'],
    ['A\tB', '\t'],
    ['A<B', '<'], ['A>B', '>'], ['A%B', '%'], ['A&B', '&'], ['A\\B', '\\'], ['A?B', '?'], ['A/B', '/'],
  ] as const) {
    it(`${JSON.stringify(name)} → ACTION_NAME_INVALID naming ${JSON.stringify(part)}`, () => {
      const r = validateFlowIR(makeIR([compose(name)]));
      const e = r.issues.filter(i => i.code === 'ACTION_NAME_INVALID');
      assert.equal(e.length, 1);
      assert.equal(e[0].level, 'error');
      assert.ok(e[0].message.includes(JSON.stringify(part)), e[0].message);
    });
  }

  it('"@", braces, quotes, parentheses, spaces and dashes are fine', () => {
    for (const name of ['B @x', 'B {x}', "B 'x'", 'B (x)', 'B — uses the payload', 'Case 2']) {
      const r = validateFlowIR(makeIR([compose(name)]));
      assert.deepEqual(r.issues.filter(i => i.code === 'ACTION_NAME_INVALID'), [], name);
    }
  });

  it('checks the trigger name in Logic Apps JSON', () => {
    const r = validateLogicApps({
      definition: {
        $schema: 'x', contentVersion: '1.0.0.0',
        triggers: { 'When a/b': { type: 'Request', kind: 'Http', inputs: {} } },
        actions: {},
      },
    });
    assert.ok(r.issues.some(i => i.code === 'ACTION_NAME_INVALID' && /Trigger/.test(i.message)));
  });
});

describe('description length in validateLogicApps', () => {
  const def = (actions: any, extra: any = {}) => ({
    definition: {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      triggers: { manual: { type: 'Request', kind: 'Http', inputs: {} } },
      actions,
      ...extra,
    },
  });

  it('256 characters is accepted, 257 is DESCRIPTION_LENGTH with the JSON path', () => {
    const r = validateLogicApps(def({
      Ok: { type: 'Compose', inputs: 1, runAfter: {}, description: 'a'.repeat(256) },
      Scope: {
        type: 'Scope',
        actions: { Inner: { type: 'Compose', inputs: 1, description: 'a'.repeat(257), runAfter: {} } },
        runAfter: {},
      },
    }));
    const e = r.issues.filter(i => i.code === 'DESCRIPTION_LENGTH');
    assert.deepEqual(e.map(i => i.path), ['definition.actions.Scope.actions.Inner.description']);
    assert.equal(e[0].level, 'error');
    assert.equal(r.ok, false);
  });

  it('walks if/else, switch cases and default', () => {
    const long = { type: 'Compose', inputs: 1, description: 'a'.repeat(300) };
    const r = validateLogicApps(def({
      Cond: {
        type: 'If', expression: { equals: [1, 1] },
        actions: { T: long },
        else: { actions: { E: long } },
        runAfter: {},
      },
      Sw: {
        type: 'Switch', expression: 'x',
        cases: { c1: { case: 'x', actions: { C: long } } },
        default: { actions: { D: long } },
        runAfter: {},
      },
    }));
    const paths = r.issues.filter(i => i.code === 'DESCRIPTION_LENGTH').map(i => i.path).sort();
    assert.deepEqual(paths, [
      'definition.actions.Cond.actions.T.description',
      'definition.actions.Cond.else.actions.E.description',
      'definition.actions.Sw.cases.c1.actions.C.description',
      'definition.actions.Sw.default.actions.D.description',
    ]);
  });

  it('checks the trigger; the flow description and the overflow metadata have no limit', () => {
    const r = validateLogicApps({
      definition: {
        $schema: 'x', contentVersion: '1.0.0.0',
        description: 'a'.repeat(1000),
        triggers: { manual: { type: 'Request', kind: 'Http', inputs: {}, description: 'a'.repeat(257) } },
        actions: {
          Long: {
            type: 'Compose', inputs: 1, runAfter: {},
            description: 'a'.repeat(255) + '…',
            metadata: { flowforgerDescription: 'a'.repeat(300) + ' then @{z}' },
          },
        },
      },
    });
    assert.deepEqual(r.issues.filter(i => i.code.startsWith('DESCRIPTION_')).map(i => i.path), ['definition.triggers.manual.description']);
  });

  it('does not look at "description" keys inside action inputs', () => {
    const r = validateLogicApps(def({
      Create: {
        type: 'OpenApiConnection',
        inputs: { parameters: { item: { description: 'a'.repeat(500) } } },
        runAfter: {},
      },
    }));
    assert.deepEqual(r.issues.filter(i => i.code.startsWith('DESCRIPTION_')), []);
  });
});
