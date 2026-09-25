/**
 * Flow scaffolds: the starting DSL behind "New flow". Every trigger variant must
 * compile through the real transformer and start with the trigger it promises.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { transformCode } from '../src/transformer/index.js';
import { resetIdCounter } from '../src/utils/id-generator.js';
import {
  buildFlowScaffold,
  toFlowClassName,
  isScaffoldTriggerKind,
  SCAFFOLD_TRIGGERS,
  DEFAULT_SCAFFOLD_TRIGGER,
} from '../src/scaffold.js';

describe('buildFlowScaffold', () => {
  beforeEach(() => resetIdCounter());

  for (const option of SCAFFOLD_TRIGGERS) {
    it(`"${option.kind}" compiles and starts with the promised trigger`, () => {
      const dsl = buildFlowScaffold({ name: 'Sales report', trigger: option.kind });
      const ir = transformCode(dsl, 'flow.ff.ts');

      assert.strictEqual(ir.name, 'Sales report');
      assert.ok(ir.nodes.length >= 2, 'scaffold has a trigger and at least one action');

      // Built-in and connector triggers are `trigger` nodes; a schedule is its own `recurrence` node
      const trigger = ir.nodes[0] as any;
      assert.ok(trigger.type === 'trigger' || trigger.type === 'recurrence', `first node is a trigger (got ${trigger.type})`);

      if (option.connector) {
        assert.strictEqual(trigger.kind, 'connector');
        assert.strictEqual(trigger.inputs.connector, option.connector);
        // A connector trigger scaffold must ship the connection reference it names
        const refName = trigger.inputs.connectionReferenceName;
        assert.ok(refName, 'connector trigger names a connection reference');
        assert.ok(ir.connectionReferences?.[refName], `connectionReferences declares ${refName}`);
      } else if (option.kind === 'recurrence') {
        assert.strictEqual(trigger.inputs.frequency, 'Day');
      } else {
        assert.strictEqual(trigger.kind, option.kind);
      }
    });
  }

  it('defaults to the manual trigger', () => {
    const dsl = buildFlowScaffold({ name: 'X' });
    assert.strictEqual(DEFAULT_SCAFFOLD_TRIGGER, 'manual');
    assert.match(dsl, /@ManualTrigger\(\)/);
  });

  it('quotes the flow name safely and derives the class name from it', () => {
    const dsl = buildFlowScaffold({ name: `Damjan's "report" 2` });
    assert.ok(dsl.startsWith(`@Flow({ name: "Damjan's \\"report\\" 2" })\nclass DamjanSReport2 {`));
    const ir = transformCode(dsl, 'flow.ff.ts');
    assert.strictEqual(ir.name, `Damjan's "report" 2`);
  });

  it('honours an explicit class name', () => {
    const dsl = buildFlowScaffold({ name: 'whatever', className: 'Custom' });
    assert.match(dsl, /^@Flow\(\{ name: "whatever" \}\)\nclass Custom \{/);
  });

  it('SharePoint scaffold reads site and list from flow parameters', () => {
    const ir = transformCode(buildFlowScaffold({ name: 'sp', trigger: 'sharepoint-item-created' }), 'flow.ff.ts');
    const trigger = ir.nodes[0] as any;
    assert.strictEqual(trigger.inputs.params.dataset, "@parameters('Site URL (cr_SiteUrl)')");
    assert.ok(ir.parameters?.['Site URL (cr_SiteUrl)'], 'parameter key matches ctx.parameters() exactly');
  });

  it('Dataverse scaffold resolves the ambient enums to numbers', () => {
    const ir = transformCode(buildFlowScaffold({ name: 'dv', trigger: 'dataverse-row-added' }), 'flow.ff.ts');
    const params = (ir.nodes[0] as any).inputs.params;
    assert.strictEqual(params['subscriptionRequest/message'], 1);
    assert.strictEqual(params['subscriptionRequest/scope'], 4);
  });
});

describe('toFlowClassName', () => {
  it('pascal-cases words and strips punctuation', () => {
    assert.strictEqual(toFlowClassName('my sales-report 2'), 'MySalesReport2');
    assert.strictEqual(toFlowClassName('invoice.approval_v2'), 'InvoiceApprovalV2');
  });

  it('never yields an identifier that starts with a digit or is empty', () => {
    assert.strictEqual(toFlowClassName('2024 report'), 'Flow2024Report');
    assert.strictEqual(toFlowClassName('!!!'), 'MyFlow');
    assert.strictEqual(toFlowClassName(''), 'MyFlow');
  });
});

describe('isScaffoldTriggerKind', () => {
  it('accepts known kinds and rejects anything else', () => {
    assert.strictEqual(isScaffoldTriggerKind('http'), true);
    assert.strictEqual(isScaffoldTriggerKind('teams-channel-message'), true);
    assert.strictEqual(isScaffoldTriggerKind('nope'), false);
    assert.strictEqual(isScaffoldTriggerKind(undefined), false);
  });
});
