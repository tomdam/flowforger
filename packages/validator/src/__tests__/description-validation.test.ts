import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlowIR, validateLogicApps } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

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

describe('description validation in validateFlowIR', () => {
  it('plain description → no issues', () => {
    const r = validateFlowIR(makeIR([compose('A', 'Builds the payload from the trigger body')]));
    assert.deepEqual(r.issues.filter(i => i.code.startsWith('DESCRIPTION_')), []);
  });

  it('@{...} in an action description → DESCRIPTION_EXPRESSION error with a path', () => {
    const r = validateFlowIR(makeIR([compose('A', "Uses @{triggerBody()?['name']} for the name")]));
    const e = r.issues.filter(i => i.code === 'DESCRIPTION_EXPRESSION');
    assert.equal(e.length, 1);
    assert.equal(e[0].level, 'error');
    assert.equal(e[0].path, 'nodes.A.description');
    assert.match(e[0].message, /@\{triggerBody\(\)\?\['name'\]\}/);
    assert.equal(r.ok, false);
  });

  it('literal empty @{} → error', () => {
    const r = validateFlowIR(makeIR([compose('A', 'see @{} syntax')]));
    assert.equal(r.issues.filter(i => i.code === 'DESCRIPTION_EXPRESSION').length, 1);
    assert.equal(r.ok, false);
  });

  it('description inside nested control flow is checked', () => {
    const r = validateFlowIR(makeIR([
      { id: 'scp_1', type: 'scope', name: 'S', actions: [compose('Inner', 'bad @{x}')] },
    ]));
    const e = r.issues.filter(i => i.code === 'DESCRIPTION_EXPRESSION');
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'nodes.Inner.description');
  });

  it('flow-level description is checked', () => {
    const r = validateFlowIR(makeIR([compose('A')], 'Flow note with @{utcNow()}'));
    const e = r.issues.filter(i => i.code === 'DESCRIPTION_EXPRESSION');
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'description');
  });

  it('leading @ → DESCRIPTION_LEADING_AT warning; @@ is fine', () => {
    const r = validateFlowIR(makeIR([compose('A', '@todo handle retries')]));
    const w = r.issues.filter(i => i.code === 'DESCRIPTION_LEADING_AT');
    assert.equal(w.length, 1);
    assert.equal(w[0].level, 'warning');
    // The generic expression walker independently rejects '@todo …' as an unparsable expression.
    assert.ok(r.issues.some(i => i.code === 'EXPR_SYNTAX'));

    const ok = validateFlowIR(makeIR([compose('A', '@@literal at sign')]));
    assert.deepEqual(ok.issues.filter(i => i.code.startsWith('DESCRIPTION_')), []);
  });
});

describe('description validation in validateLogicApps', () => {
  const def = (actions: any, extra: any = {}) => ({
    definition: {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      triggers: { manual: { type: 'Request', kind: 'Http', inputs: {} } },
      actions,
      ...extra,
    },
  });

  it('flags @{...} in a nested action description with the JSON path', () => {
    const r = validateLogicApps(def({
      Scope: {
        type: 'Scope',
        actions: {
          Inner: { type: 'Compose', inputs: 1, description: "Uses @{variables('x')} here", runAfter: {} },
        },
        runAfter: {},
      },
    }));
    const e = r.issues.filter(i => i.code === 'DESCRIPTION_EXPRESSION');
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'definition.actions.Scope.actions.Inner.description');
    assert.equal(r.ok, false);
  });

  it('walks if/else, switch cases and default', () => {
    const r = validateLogicApps(def({
      Cond: {
        type: 'If', expression: { equals: [1, 1] },
        actions: { T: { type: 'Compose', inputs: 1, description: '@{a}' } },
        else: { actions: { E: { type: 'Compose', inputs: 1, description: '@{b}' } } },
        runAfter: {},
      },
      Sw: {
        type: 'Switch', expression: 'x',
        cases: { c1: { case: 'x', actions: { C: { type: 'Compose', inputs: 1, description: '@{c}' } } } },
        default: { actions: { D: { type: 'Compose', inputs: 1, description: '@{d}' } } },
        runAfter: {},
      },
    }));
    const paths = r.issues.filter(i => i.code === 'DESCRIPTION_EXPRESSION').map(i => i.path).sort();
    assert.deepEqual(paths, [
      'definition.actions.Cond.actions.T.description',
      'definition.actions.Cond.else.actions.E.description',
      'definition.actions.Sw.cases.c1.actions.C.description',
      'definition.actions.Sw.default.actions.D.description',
    ]);
  });

  it('does NOT flag "description" keys inside action inputs (those are legitimate expressions)', () => {
    const r = validateLogicApps(def({
      Create: {
        type: 'OpenApiConnection',
        inputs: { parameters: { item: { description: "@{variables('x')}" } } },
        runAfter: {},
      },
    }));
    assert.deepEqual(r.issues.filter(i => i.code.startsWith('DESCRIPTION_')), []);
  });

  it('checks the trigger, the flow description and the overflow metadata text', () => {
    const r = validateLogicApps({
      definition: {
        $schema: 'x', contentVersion: '1.0.0.0',
        description: 'Flow @{x}',
        triggers: { manual: { type: 'Request', kind: 'Http', inputs: {}, description: '@{y}' } },
        actions: {
          Long: {
            type: 'Compose', inputs: 1, runAfter: {},
            description: 'a'.repeat(254) + '…',
            metadata: { flowforgerDescription: 'a'.repeat(300) + ' then @{z}' },
          },
        },
      },
    });
    const paths = r.issues.filter(i => i.code === 'DESCRIPTION_EXPRESSION').map(i => i.path).sort();
    assert.deepEqual(paths, [
      'definition.actions.Long.metadata.flowforgerDescription',
      'definition.description',
      'definition.triggers.manual.description',
    ]);
  });
});
