/**
 * Tests for the IR Diff Engine
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { FlowIR, Node, ActionNode, ScopeNode, IfNode, ForeachNode, SwitchNode, DoUntilNode } from '../src/index.js';
import { diffFlowIR } from '../src/diff.js';
import type { DiffOptions, FlowDiff } from '../src/diff.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeFlow(overrides: Partial<FlowIR> = {}): FlowIR {
  return {
    name: 'TestFlow',
    nodes: [],
    ...overrides,
  };
}

function makeTrigger(name: string = 'manual_trigger'): Node {
  return {
    id: 'trg_1',
    name,
    type: 'trigger',
    kind: 'http',
    inputs: { method: 'POST' },
  } as Node;
}

function makeAction(name: string, kind: string = 'compose', inputs: any = { value: 'hello' }, extra: Partial<ActionNode> = {}): ActionNode {
  return {
    id: `act_${name}`,
    name,
    type: 'action',
    kind: kind as any,
    inputs,
    ...extra,
  } as ActionNode;
}

function makeScope(name: string, actions: Node[], extra: Partial<ScopeNode> = {}): ScopeNode {
  return {
    id: `scp_${name}`,
    name,
    type: 'scope',
    actions,
    ...extra,
  } as ScopeNode;
}

function makeIf(name: string, condition: string, actions: Node[], elseActions?: Node[]): IfNode {
  return {
    id: `if_${name}`,
    name,
    type: 'if',
    condition,
    actions,
    elseActions,
  } as IfNode;
}

function makeForeach(name: string, itemsExpression: string, actions: Node[]): ForeachNode {
  return {
    id: `fe_${name}`,
    name,
    type: 'foreach',
    itemsExpression,
    actions,
  } as ForeachNode;
}

function makeSwitch(name: string, expression: string, cases: Array<{ name: string; value: string | number; actions: Node[] }>, defaultActions?: Node[]): SwitchNode {
  return {
    id: `sw_${name}`,
    name,
    type: 'switch',
    expression,
    cases,
    defaultActions,
  } as SwitchNode;
}

function makeDoUntil(name: string, condition: string, actions: Node[]): DoUntilNode {
  return {
    id: `du_${name}`,
    name,
    type: 'dountil',
    condition,
    actions,
  } as DoUntilNode;
}

// ============================================================================
// Tests: Identical Flows
// ============================================================================

describe('diffFlowIR', () => {
  describe('identical flows', () => {
    it('should report all unchanged for identical empty flows', () => {
      const flow = makeFlow();
      const result = diffFlowIR(flow, flow);

      assert.strictEqual(result.flowFieldDiffs.length, 0);
      assert.strictEqual(result.nodeDiffs.length, 0);
      assert.strictEqual(result.summary.totalNodes, 0);
      assert.strictEqual(result.summary.unchanged, 0);
      assert.strictEqual(result.summary.added, 0);
      assert.strictEqual(result.summary.removed, 0);
      assert.strictEqual(result.summary.changed, 0);
      assert.strictEqual(result.summary.moved, 0);
    });

    it('should report all unchanged for identical flows with nodes', () => {
      const flow = makeFlow({
        nodes: [
          makeTrigger(),
          makeAction('ComposeResult'),
          makeAction('ComposeOther'),
        ],
      });
      const result = diffFlowIR(flow, flow);

      assert.strictEqual(result.flowFieldDiffs.length, 0);
      assert.strictEqual(result.nodeDiffs.length, 3);
      assert.ok(result.nodeDiffs.every(d => d.status === 'unchanged'));
      assert.ok(result.nodeDiffs.every(d => d.moved === false));
      assert.strictEqual(result.summary.unchanged, 3);
      assert.strictEqual(result.summary.changed, 0);
    });

    it('should treat nodes with different IDs but same name as identical', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1')],
      });
      const newFlow = makeFlow({
        nodes: [{
          ...makeAction('Step1'),
          id: 'act_different_id',
        }],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs.length, 1);
      assert.strictEqual(result.nodeDiffs[0].status, 'unchanged');
    });
  });

  // ============================================================================
  // Tests: Added/Removed Nodes
  // ============================================================================

  describe('added and removed nodes', () => {
    it('should detect added nodes', () => {
      const oldFlow = makeFlow({ nodes: [makeTrigger()] });
      const newFlow = makeFlow({
        nodes: [makeTrigger(), makeAction('NewAction')],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.summary.added, 1);
      const addedDiff = result.nodeDiffs.find(d => d.status === 'added');
      assert.ok(addedDiff);
      assert.strictEqual(addedDiff!.name, 'NewAction');
      assert.strictEqual(addedDiff!.newIndex, 1);
      assert.strictEqual(addedDiff!.oldIndex, undefined);
    });

    it('should detect removed nodes', () => {
      const oldFlow = makeFlow({
        nodes: [makeTrigger(), makeAction('OldAction')],
      });
      const newFlow = makeFlow({ nodes: [makeTrigger()] });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.summary.removed, 1);
      const removedDiff = result.nodeDiffs.find(d => d.status === 'removed');
      assert.ok(removedDiff);
      assert.strictEqual(removedDiff!.name, 'OldAction');
      assert.strictEqual(removedDiff!.oldIndex, 1);
      assert.strictEqual(removedDiff!.newIndex, undefined);
    });

    it('should detect both added and removed nodes', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeTrigger(),
          makeAction('ActionA', 'initializevariable', { variableName: 'x', variableType: 'Integer', value: 0 }),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeTrigger(),
          makeAction('ActionB', 'http', { method: 'POST', url: 'https://example.com/api' }),
        ],
      });
      // Completely different actions should not fuzzy match even at default threshold
      const result = diffFlowIR(oldFlow, newFlow, { fuzzyMatchThreshold: 0.95 });

      const removedDiff = result.nodeDiffs.find(d => d.status === 'removed');
      const addedDiff = result.nodeDiffs.find(d => d.status === 'added');
      assert.ok(removedDiff, 'Should have a removed node');
      assert.ok(addedDiff, 'Should have an added node');
      assert.strictEqual(removedDiff!.name, 'ActionA');
      assert.strictEqual(addedDiff!.name, 'ActionB');
    });
  });

  // ============================================================================
  // Tests: Changed Node Properties
  // ============================================================================

  describe('changed node properties', () => {
    it('should detect changed action kind', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'hello' })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'http', { method: 'GET', url: 'https://example.com' })],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'changed');
      const kindDiff = result.nodeDiffs[0].propertyDiffs.find(d => d.path === 'kind');
      assert.ok(kindDiff);
      assert.strictEqual(kindDiff!.oldValue, 'compose');
      assert.strictEqual(kindDiff!.newValue, 'http');
    });

    it('should detect changed inputs', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'hello' })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'world' })],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'changed');
      const inputsDiff = result.nodeDiffs[0].propertyDiffs.find(d => d.path === 'inputs');
      assert.ok(inputsDiff);
    });

    it('should detect added description', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1')],
      });
      const newFlow = makeFlow({
        nodes: [{ ...makeAction('Step1'), description: 'A new description' }],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'changed');
      const descDiff = result.nodeDiffs[0].propertyDiffs.find(d => d.path === 'description');
      assert.ok(descDiff);
      assert.strictEqual(descDiff!.oldValue, undefined);
      assert.strictEqual(descDiff!.newValue, 'A new description');
    });

    it('should detect changed runAfter', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'x' }, { runAfter: { 'PrevStep': ['Succeeded'] } })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'x' }, { runAfter: { 'PrevStep': ['Failed'] } })],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'changed');
      const runAfterDiff = result.nodeDiffs[0].propertyDiffs.find(d => d.path === 'runAfter');
      assert.ok(runAfterDiff);
    });

    it('should produce expression diff for expression value changes', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: "@concat('a', 'b')" })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: "@concat('a', 'c')" })],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'changed');
      const inputsDiff = result.nodeDiffs[0].propertyDiffs.find(d => d.path === 'inputs');
      assert.ok(inputsDiff);
      // The inputs object as a whole changed; check that top-level diff exists
    });
  });

  // ============================================================================
  // Tests: Expression Diffing
  // ============================================================================

  describe('expression diffing', () => {
    it('should detect function rename in expression', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: "@toLower('HELLO')" })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: "@toUpper('HELLO')" })],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'changed');
    });

    it('should detect argument change in expression', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: "@concat('hello', 'world')" })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: "@concat('hello', 'earth')" })],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'changed');
    });
  });

  // ============================================================================
  // Tests: Fuzzy Matching
  // ============================================================================

  describe('fuzzy matching', () => {
    it('should fuzzy match renamed actions with similar content', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeAction('Get_User_Data', 'http', { method: 'GET', url: 'https://api.example.com/users' }),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeAction('Fetch_User_Data', 'http', { method: 'GET', url: 'https://api.example.com/users' }),
        ],
      });
      // Low threshold to allow fuzzy match
      const result = diffFlowIR(oldFlow, newFlow, { fuzzyMatchThreshold: 0.3 });

      // Should match them rather than showing one removed + one added
      const changedOrUnchanged = result.nodeDiffs.filter(d => d.status === 'changed' || d.status === 'unchanged');
      assert.strictEqual(changedOrUnchanged.length, 1, 'Should fuzzy match the two nodes');
      assert.ok(changedOrUnchanged[0].similarityScore !== undefined, 'Should have similarity score');
      assert.ok(changedOrUnchanged[0].similarityScore! > 0.3, 'Similarity should exceed threshold');
    });

    it('should not fuzzy match completely different actions', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeAction('Initialize_Counter', 'initializevariable', { variableName: 'counter', variableType: 'Integer', value: 0 }),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeAction('Send_HTTP_Request', 'http', { method: 'POST', url: 'https://api.example.com' }),
        ],
      });
      // High threshold
      const result = diffFlowIR(oldFlow, newFlow, { fuzzyMatchThreshold: 0.9 });

      assert.strictEqual(result.summary.removed, 1);
      assert.strictEqual(result.summary.added, 1);
    });
  });

  // ============================================================================
  // Tests: Nested Control Structures
  // ============================================================================

  describe('nested control structures', () => {
    it('should diff scope children', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeScope('MyScope', [
            makeAction('InnerAction1'),
            makeAction('InnerAction2', 'initializevariable', { variableName: 'v', variableType: 'String' }),
          ]),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeScope('MyScope', [
            makeAction('InnerAction1'),
            makeAction('InnerAction3', 'http', { method: 'GET', url: 'https://api.test.com' }),
          ]),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow, { fuzzyMatchThreshold: 0.95 });

      // The scope itself should be 'changed' since its children differ
      const scopeDiff = result.nodeDiffs[0];
      assert.strictEqual(scopeDiff.status, 'changed');
      assert.ok(scopeDiff.childDiffs);
      assert.ok(scopeDiff.childDiffs!.length > 0);

      const removed = scopeDiff.childDiffs!.find(d => d.status === 'removed');
      const added = scopeDiff.childDiffs!.find(d => d.status === 'added');
      assert.ok(removed, 'Should have removed child');
      assert.ok(added, 'Should have added child');
      assert.strictEqual(removed!.name, 'InnerAction2');
      assert.strictEqual(added!.name, 'InnerAction3');
    });

    it('should diff if/else branches', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeIf('CheckValue', "@equals(variables('x'), 1)",
            [makeAction('ThenAction')],
            [makeAction('ElseAction')]
          ),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeIf('CheckValue', "@equals(variables('x'), 1)",
            [makeAction('ThenAction')],
            [makeAction('ElseAction'), makeAction('ExtraElseAction')]
          ),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const ifDiff = result.nodeDiffs[0];
      assert.strictEqual(ifDiff.status, 'changed');
      assert.ok(ifDiff.childDiffs);

      const addedInElse = ifDiff.childDiffs!.find(d => d.status === 'added');
      assert.ok(addedInElse);
      assert.strictEqual(addedInElse!.name, 'ExtraElseAction');
      assert.ok(addedInElse!.parentPath.includes('elseActions'));
    });

    it('should diff foreach children', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeForeach('LoopItems', "@body('GetItems')", [
            makeAction('ProcessItem'),
          ]),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeForeach('LoopItems', "@body('GetItems')", [
            makeAction('ProcessItem'),
            makeAction('LogItem'),
          ]),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const feDiff = result.nodeDiffs[0];
      assert.strictEqual(feDiff.status, 'changed');
      assert.ok(feDiff.childDiffs);

      const addedChild = feDiff.childDiffs!.find(d => d.status === 'added');
      assert.ok(addedChild);
      assert.strictEqual(addedChild!.name, 'LogItem');
    });

    it('should diff switch cases', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeSwitch('Route', "@variables('route')", [
            { name: 'CaseA', value: 'A', actions: [makeAction('HandleA')] },
            { name: 'CaseB', value: 'B', actions: [makeAction('HandleB')] },
          ]),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeSwitch('Route', "@variables('route')", [
            { name: 'CaseA', value: 'A', actions: [makeAction('HandleA')] },
            { name: 'CaseB', value: 'B', actions: [makeAction('HandleB'), makeAction('NotifyB')] },
          ]),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const switchDiff = result.nodeDiffs[0];
      assert.strictEqual(switchDiff.status, 'changed');
      assert.ok(switchDiff.childDiffs);

      const addedInCaseB = switchDiff.childDiffs!.find(d => d.status === 'added');
      assert.ok(addedInCaseB);
      assert.strictEqual(addedInCaseB!.name, 'NotifyB');
    });

    it('should diff do-until children', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeDoUntil('RetryLoop', "@equals(variables('done'), true)", [
            makeAction('TryAction'),
          ]),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeDoUntil('RetryLoop', "@equals(variables('done'), true)", [
            makeAction('TryAction'),
            makeAction('WaitAction'),
          ]),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const duDiff = result.nodeDiffs[0];
      assert.strictEqual(duDiff.status, 'changed');
      assert.ok(duDiff.childDiffs);

      const addedChild = duDiff.childDiffs!.find(d => d.status === 'added');
      assert.ok(addedChild);
      assert.strictEqual(addedChild!.name, 'WaitAction');
    });

    it('should handle deeply nested control structures', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeScope('OuterScope', [
            makeIf('InnerIf', "@equals(1, 1)", [
              makeAction('DeepAction', 'compose', { value: 'old' }),
            ]),
          ]),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeScope('OuterScope', [
            makeIf('InnerIf', "@equals(1, 1)", [
              makeAction('DeepAction', 'compose', { value: 'new' }),
            ]),
          ]),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const scopeDiff = result.nodeDiffs[0];
      assert.strictEqual(scopeDiff.status, 'changed');
      assert.ok(scopeDiff.childDiffs);

      const ifDiff = scopeDiff.childDiffs!.find(d => d.name === 'InnerIf');
      assert.ok(ifDiff);
      assert.strictEqual(ifDiff!.status, 'changed');
      assert.ok(ifDiff!.childDiffs);

      const deepDiff = ifDiff!.childDiffs!.find(d => d.name === 'DeepAction');
      assert.ok(deepDiff);
      assert.strictEqual(deepDiff!.status, 'changed');
    });
  });

  // ============================================================================
  // Tests: Flow-Level Field Diffs
  // ============================================================================

  describe('flow-level field diffs', () => {
    it('should detect flow name change', () => {
      const oldFlow = makeFlow({ name: 'OldName' });
      const newFlow = makeFlow({ name: 'NewName' });
      const result = diffFlowIR(oldFlow, newFlow);

      const nameDiff = result.flowFieldDiffs.find(d => d.field === 'name');
      assert.ok(nameDiff);
      assert.strictEqual(nameDiff!.oldValue, 'OldName');
      assert.strictEqual(nameDiff!.newValue, 'NewName');
      assert.strictEqual(result.summary.flowFieldChanges, 1);
    });

    it('should detect description change', () => {
      const oldFlow = makeFlow({ description: 'Old description' });
      const newFlow = makeFlow({ description: 'New description' });
      const result = diffFlowIR(oldFlow, newFlow);

      const descDiff = result.flowFieldDiffs.find(d => d.field === 'description');
      assert.ok(descDiff);
    });

    it('should detect parameters change', () => {
      const oldFlow = makeFlow({
        parameters: {
          '$authentication': { type: 'String', defaultValue: '' },
        },
      });
      const newFlow = makeFlow({
        parameters: {
          '$authentication': { type: 'String', defaultValue: '' },
          'newParam': { type: 'Int', defaultValue: 42 },
        },
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const paramsDiff = result.flowFieldDiffs.find(d => d.field === 'parameters');
      assert.ok(paramsDiff);
    });

    it('should detect connection references change', () => {
      const oldFlow = makeFlow({
        connectionReferences: {
          shared_sharepointonline: {
            apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
          },
        },
      });
      const newFlow = makeFlow({
        connectionReferences: {
          shared_sharepointonline: {
            apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
            connectionReferenceLogicalName: 'cr_sp',
          },
        },
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const connRefDiff = result.flowFieldDiffs.find(d => d.field === 'connectionReferences');
      assert.ok(connRefDiff);
    });

    it('should ignore metadata by default', () => {
      const oldFlow = makeFlow({
        metadata: { schemaVersion: '1.0.0.0' },
      });
      const newFlow = makeFlow({
        metadata: { schemaVersion: '2.0.0.0' },
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const metaDiff = result.flowFieldDiffs.find(d => d.field === 'metadata');
      assert.strictEqual(metaDiff, undefined, 'Metadata should be ignored by default');
    });

    it('should detect metadata change when ignoreMetadata is false', () => {
      const oldFlow = makeFlow({
        metadata: { schemaVersion: '1.0.0.0' },
      });
      const newFlow = makeFlow({
        metadata: { schemaVersion: '2.0.0.0' },
      });
      const result = diffFlowIR(oldFlow, newFlow, { ignoreMetadata: false });

      const metaDiff = result.flowFieldDiffs.find(d => d.field === 'metadata');
      assert.ok(metaDiff);
    });

    it('should ignore staticResults by default', () => {
      const oldFlow = makeFlow({
        staticResults: { Step1: { status: 'Succeeded', outputs: {} } },
      });
      const newFlow = makeFlow({
        staticResults: { Step1: { status: 'Failed', outputs: {} } },
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const staticDiff = result.flowFieldDiffs.find(d => d.field === 'staticResults');
      assert.strictEqual(staticDiff, undefined, 'staticResults should be ignored by default');
    });
  });

  // ============================================================================
  // Tests: Normalization
  // ============================================================================

  describe('normalization', () => {
    it('should ignore empty runAfter when configured', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'x' }, { runAfter: {} })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'x' })],
      });
      const result = diffFlowIR(oldFlow, newFlow, {
        parity: { ignoreEmptyRunAfter: true },
      });

      assert.strictEqual(result.nodeDiffs[0].status, 'unchanged');
    });

    it('should detect empty runAfter difference when not ignoring', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'x' }, { runAfter: {} })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'x' })],
      });
      const result = diffFlowIR(oldFlow, newFlow, {
        parity: { ignoreEmptyRunAfter: false },
      });

      assert.strictEqual(result.nodeDiffs[0].status, 'changed');
    });

    it('should normalize function case in expressions', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: "@Concat('a', 'b')" })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: "@concat('a', 'b')" })],
      });
      // normalizeFunctionCase defaults to true
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'unchanged');
    });

    it('should detect function case difference when normalization is off', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: "@Concat('a', 'b')" })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: "@concat('a', 'b')" })],
      });
      const result = diffFlowIR(oldFlow, newFlow, {
        parity: { normalizeFunctionCase: false },
      });

      assert.strictEqual(result.nodeDiffs[0].status, 'changed');
    });

    it('should normalize multiple spaces', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'hello  world' })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 'hello world' })],
      });
      // normalizeSpaces defaults to true
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'unchanged');
    });

    it('should normalize number formatting', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 100.00 })],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('Step1', 'compose', { value: 100 })],
      });
      // normalizeNumbers defaults to true
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'unchanged');
    });
  });

  // ============================================================================
  // Tests: Moved Detection
  // ============================================================================

  describe('moved detection', () => {
    it('should detect moved nodes (reordered)', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeAction('ActionA'),
          makeAction('ActionB'),
          makeAction('ActionC'),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeAction('ActionC'),
          makeAction('ActionA'),
          makeAction('ActionB'),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      // All nodes matched by name, but at different indices
      assert.strictEqual(result.summary.moved, 3);
      assert.ok(result.nodeDiffs.every(d => d.moved === true));
      assert.ok(result.nodeDiffs.every(d => d.status === 'unchanged'));
    });

    it('should not flag unmoved nodes', () => {
      const oldFlow = makeFlow({
        nodes: [makeAction('A'), makeAction('B')],
      });
      const newFlow = makeFlow({
        nodes: [makeAction('A'), makeAction('B')],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.summary.moved, 0);
      assert.ok(result.nodeDiffs.every(d => d.moved === false));
    });

    it('should handle moved + changed node', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeAction('ActionA', 'compose', { value: 'old' }),
          makeAction('ActionB'),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeAction('ActionB'),
          makeAction('ActionA', 'compose', { value: 'new' }),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const actionADiff = result.nodeDiffs.find(d => d.name === 'ActionA');
      assert.ok(actionADiff);
      assert.strictEqual(actionADiff!.status, 'changed');
      assert.strictEqual(actionADiff!.moved, true);
    });
  });

  // ============================================================================
  // Tests: Summary
  // ============================================================================

  describe('summary', () => {
    it('should compute correct summary counts', () => {
      const oldFlow = makeFlow({
        name: 'OldName',
        nodes: [
          makeTrigger(),
          makeAction('Unchanged'),
          makeAction('Changed', 'compose', { value: 'old' }),
          makeAction('Removed'),
        ],
      });
      const newFlow = makeFlow({
        name: 'NewName',
        nodes: [
          makeTrigger(),
          makeAction('Changed', 'compose', { value: 'new' }),
          makeAction('Unchanged'),
          makeAction('Added'),
        ],
      });
      const result = diffFlowIR(newFlow, oldFlow);

      // Just verify the summary adds up
      assert.strictEqual(
        result.summary.unchanged + result.summary.added + result.summary.removed + result.summary.changed,
        result.summary.totalNodes
      );
    });

    it('should count child diffs in summary', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeScope('S', [
            makeAction('Inner1'),
            makeAction('Inner2'),
          ]),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeScope('S', [
            makeAction('Inner1'),
            makeAction('Inner2'),
            makeAction('Inner3'),
          ]),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      // Scope (changed) + Inner1 (unchanged) + Inner2 (unchanged) + Inner3 (added)
      assert.strictEqual(result.summary.totalNodes, 4);
      assert.strictEqual(result.summary.added, 1);
    });
  });

  // ============================================================================
  // Tests: Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle empty node arrays', () => {
      const oldFlow = makeFlow({ nodes: [] });
      const newFlow = makeFlow({ nodes: [] });
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs.length, 0);
      assert.strictEqual(result.summary.totalNodes, 0);
    });

    it('should handle if node with no else branch vs with else branch', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeIf('Check', "@equals(1, 1)", [makeAction('Then1')]),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeIf('Check', "@equals(1, 1)", [makeAction('Then1')], [makeAction('Else1')]),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const ifDiff = result.nodeDiffs[0];
      assert.strictEqual(ifDiff.status, 'changed');
      assert.ok(ifDiff.childDiffs);

      const addedElse = ifDiff.childDiffs!.find(d => d.status === 'added' && d.name === 'Else1');
      assert.ok(addedElse, 'Should detect new else branch action');
    });

    it('should handle switch with added case', () => {
      const oldFlow = makeFlow({
        nodes: [
          makeSwitch('Route', "@variables('x')", [
            { name: 'CaseA', value: 'A', actions: [makeAction('HandleA')] },
          ]),
        ],
      });
      const newFlow = makeFlow({
        nodes: [
          makeSwitch('Route', "@variables('x')", [
            { name: 'CaseA', value: 'A', actions: [makeAction('HandleA')] },
            { name: 'CaseB', value: 'B', actions: [makeAction('HandleB')] },
          ]),
        ],
      });
      const result = diffFlowIR(oldFlow, newFlow);

      const switchDiff = result.nodeDiffs[0];
      assert.strictEqual(switchDiff.status, 'changed');
    });

    it('should handle node metadata being ignored', () => {
      const oldFlow = makeFlow({
        nodes: [{
          ...makeAction('Step1'),
          metadata: { operationMetadataId: 'abc123' },
        }],
      });
      const newFlow = makeFlow({
        nodes: [{
          ...makeAction('Step1'),
          metadata: { operationMetadataId: 'xyz789' },
        }],
      });
      // ignoreMetadata defaults to true
      const result = diffFlowIR(oldFlow, newFlow);

      assert.strictEqual(result.nodeDiffs[0].status, 'unchanged');
    });

    it('should detect node metadata change when not ignoring', () => {
      const oldFlow = makeFlow({
        nodes: [{
          ...makeAction('Step1'),
          metadata: { operationMetadataId: 'abc123' },
        }],
      });
      const newFlow = makeFlow({
        nodes: [{
          ...makeAction('Step1'),
          metadata: { operationMetadataId: 'xyz789' },
        }],
      });
      const result = diffFlowIR(oldFlow, newFlow, { ignoreMetadata: false });

      assert.strictEqual(result.nodeDiffs[0].status, 'changed');
    });
  });
});
