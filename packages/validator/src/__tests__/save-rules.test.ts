import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLogicApps } from '../index.js';

// Cases and the cloud's verdicts from conformance/save-rules (node conformance/harness/save-rules.mjs
// <set>). Loaded at runtime: the conformance folder is outside this package's rootDir. The
// runafter-path set has its own test (runafter-path.test.ts), which also checks the messages.
const saveRules = new URL('../../../../conformance/save-rules/', import.meta.url);

interface Case {
  id: string;
  note: string;
  /** The validator code the case exercises; null for a control case. */
  code: string | null;
  actions: Record<string, unknown>;
  trigger?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  connectionReferences?: Record<string, unknown>;
}

const MANUAL = { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object', properties: {}, required: [] } } } };

function logicApps(c: Case) {
  return {
    properties: {
      connectionReferences: c.connectionReferences ?? {},
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        parameters: {
          $connections: { type: 'Object', defaultValue: {} },
          $authentication: { type: 'SecureObject', defaultValue: {} },
          ...c.parameters,
        },
        triggers: c.trigger ?? MANUAL,
        actions: c.actions,
      },
    },
  };
}

for (const set of ['placement', 'structure', 'expressions']) {
  const { cases } = (await import(new URL(`${set}.mjs`, saveRules).href)) as { cases: Case[] };
  const cloud: Record<string, { accepted: boolean; error?: string }> = JSON.parse(
    readFileSync(new URL(`${set}.cloud.json`, saveRules), 'utf8'),
  );

  describe(`save rules match the cloud (conformance/save-rules/${set})`, () => {
    it('every case has a recorded cloud verdict', () => {
      assert.deepEqual(cases.map((c) => c.id).filter((id) => !cloud[id]), []);
    });

    for (const c of cases) {
      const verdict = cloud[c.id];
      if (!verdict) continue;
      it(`${c.id}: ${verdict.accepted ? 'accepted' : 'rejected'} — ${c.note}`, () => {
        const issues = validateLogicApps(logicApps(c)).issues;
        const errors = issues.filter((i) => i.level === 'error');
        if (verdict.accepted) {
          // Warnings are allowed: some rules describe runtime behaviour, not a save check.
          assert.deepEqual(errors, []);
        } else {
          assert.ok(c.code, `the cloud rejects '${c.id}', so the case must name the validator code that catches it: ${verdict.error}`);
          assert.ok(
            errors.some((i) => i.code === c.code),
            `expected an error ${c.code}; got ${JSON.stringify(issues.map((i) => `${i.level} ${i.code}`))}\ncloud: ${verdict.error}`,
          );
        }
      });
    }
  });
}
