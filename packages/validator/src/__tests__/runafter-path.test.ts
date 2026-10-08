import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateFlowIR, validateLogicApps, type ValidationIssue } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

// Cases and the cloud's verdicts from conformance/save-rules (node conformance/harness/save-rules.mjs).
// Loaded at runtime: the conformance folder is outside this package's rootDir.
const saveRules = new URL('../../../../conformance/save-rules/', import.meta.url);
const { cases } = (await import(new URL('runafter-path.mjs', saveRules).href)) as {
  cases: Array<{ id: string; note: string; actions: Record<string, unknown> }>;
};
const cloud: Record<string, { accepted: boolean; error?: string }> = JSON.parse(
  readFileSync(new URL('runafter-path.cloud.json', saveRules), 'utf8'),
);

const REFERENCE_CODES = new Set(['EXPR_RUNAFTER_PATH', 'EXPR_SELF_REFERENCE', 'EXPR_UNKNOWN_ACTION']);
const referenceIssues = (r: { issues: ValidationIssue[] }) => r.issues.filter((i) => REFERENCE_CODES.has(i.code));

function logicApps(actions: Record<string, unknown>) {
  return {
    properties: {
      connectionReferences: {},
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        parameters: { $connections: { type: 'Object', defaultValue: {} } },
        triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } },
        actions,
      },
    },
  };
}

describe('runAfter path rule matches the cloud (conformance/save-rules/runafter-path)', () => {
  it('every case has a recorded cloud verdict', () => {
    assert.deepEqual(cases.map((c) => c.id).filter((id) => !cloud[id]), []);
  });

  for (const c of cases) {
    const verdict = cloud[c.id];
    if (!verdict) continue;
    it(`${c.id}: ${verdict.accepted ? 'accepted' : 'rejected'} — ${c.note}`, () => {
      const issues = referenceIssues(validateLogicApps(logicApps(c.actions)));
      if (verdict.accepted) {
        assert.deepEqual(issues, []);
        return;
      }
      assert.equal(issues.length, 1, JSON.stringify(issues));
      // The cloud names the reading action and the action it reads; so must we.
      const m = verdict.error!.match(/template action '([^']+)'.*?(?:cannot reference action '([^']+)'|cannot reference itself)/)
        ?? verdict.error!.match(/action\(s\) '([^']+)' referenced by 'inputs' in action '([^']+)'/);
      assert.ok(m, verdict.error);
      if (/cannot reference itself/.test(verdict.error!)) {
        assert.equal(issues[0].code, 'EXPR_SELF_REFERENCE');
        assert.match(issues[0].message, new RegExp(`^'${m[1]}' references \\w+\\('${m[1]}'\\)`));
      } else if (/not defined in the template/.test(verdict.error!)) {
        assert.equal(issues[0].code, 'EXPR_UNKNOWN_ACTION');
        assert.match(issues[0].message, new RegExp(`^'${m[2]}' references \\w+\\('${m[1]}'\\)`));
      } else {
        assert.equal(issues[0].code, 'EXPR_RUNAFTER_PATH');
        assert.match(issues[0].message, new RegExp(`^'${m[1]}' references \\w+\\('${m[2]}'\\)`));
      }
    });
  }
});

const trigger = { id: 'trg_1', type: 'trigger', name: 'manual', kind: 'manual', inputs: {} };
const ir = (nodes: any[]) => ({ name: 'T', nodes: [trigger, ...nodes] }) as unknown as FlowIR;
const compose = (name: string, value: any = 1, runAfter?: Record<string, string[]>) =>
  ({ id: `act_${name}`, type: 'action', name, kind: 'compose', inputs: { value }, ...(runAfter ? { runAfter } : {}) });
const scope = (name: string, actions: any[], runAfter?: Record<string, string[]>) =>
  ({ id: `scp_${name}`, type: 'scope', name, actions, ...(runAfter ? { runAfter } : {}) });
const pathIssues = (f: FlowIR) => validateFlowIR(f).issues.filter((i) => i.code === 'EXPR_RUNAFTER_PATH' || i.code === 'EXPR_SELF_REFERENCE');

describe('runAfter path rule on Flow IR', () => {
  it('a node without runAfter runs after its previous sibling, as the emitter writes it', () => {
    assert.deepEqual(pathIssues(ir([compose('A'), compose('B'), compose('C', "@outputs('A')")])), []);
  });

  it('runAfter {} starts a parallel branch', () => {
    const issues = pathIssues(ir([compose('A'), compose('B', "@outputs('A')", {})]));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, 'nodes.B.value');
    assert.match(issues[0].message, /'A' is not a runAfter predecessor of 'B': it runs in parallel or later/);
  });

  it('a join that lists both branches may read both', () => {
    const f = ir([compose('A'), compose('B', 2, {}), compose('C', "@concat(outputs('A'), outputs('B'))", { A: ['Succeeded'], B: ['Succeeded'] })]);
    assert.deepEqual(pathIssues(f), []);
  });

  it('a join that lists one branch cannot read the other', () => {
    const f = ir([compose('A'), compose('B', 2, {}), compose('C', "@outputs('B')", { A: ['Succeeded'] })]);
    assert.equal(pathIssues(f).length, 1);
  });

  it('an action inside a scope reads what the scope runs after, and what is nested in it', () => {
    const f = ir([
      scope('S1', [compose('X')]),
      scope('S2', [compose('Y', "@concat(outputs('X'), string(result('S1')))")]),
    ]);
    assert.deepEqual(pathIssues(f), []);
  });

  it('an action inside a scope cannot read the scope', () => {
    const issues = pathIssues(ir([scope('S', [compose('Inner', "@result('S')")])]));
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /'Inner' is inside 'S'/);
  });

  it('branches of a condition cannot read each other', () => {
    const f = ir([{ id: 'if_I', type: 'if', name: 'I', condition: '@true', actions: [compose('T')], elseActions: [compose('E', "@outputs('T')")] }]);
    const issues = pathIssues(f);
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /'T' is in another branch of 'I'/);
  });

  it("an Until's condition reads its body; a foreach expression cannot read its own body", () => {
    const f = ir([
      { id: 'du_U', type: 'dountil', name: 'U', condition: "@equals(outputs('Step'), 1)", actions: [compose('Step')] },
      { id: 'fe_L', type: 'foreach', name: 'L', itemsExpression: "@createArray(outputs('Inner'))", actions: [compose('Inner')] },
    ]);
    const issues = pathIssues(f);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, 'nodes.L.itemsExpression');
  });

  it('an action reading itself → EXPR_SELF_REFERENCE', () => {
    const issues = pathIssues(ir([compose('A', "@outputs('A')")]));
    assert.deepEqual(issues.map((i) => i.code), ['EXPR_SELF_REFERENCE']);
  });

  it('the hint names the block to add to runAfter when the read action is nested', () => {
    const f = ir([scope('S', [compose('Inner')]), compose('C', "@outputs('Inner')", {})]);
    const issues = pathIssues(f);
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /'S' \(which contains 'Inner'\) is not a runAfter predecessor of 'C'/);
    assert.match(issues[0].message, /Add 'S' to the runAfter of 'C'/);
  });
});
