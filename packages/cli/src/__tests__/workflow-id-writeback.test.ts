import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFlowWorkflowId } from '../workflow-id-writeback.js';

const GUID = '11111111-2222-3333-4444-555555555555';

// Line endings are spelled with explicit escapes rather than taken from this
// file's own bytes: git's autocrlf would otherwise rewrite them on checkout.
const OBJECT_FORM =
  "import { Flow } from '@flowforger/dsl-native';\n\n@Flow({\n  name: \"My Flow\"\n})\nexport class MyFlow {}\n";

describe('writeFlowWorkflowId', () => {
  function withTempFile(content: string, fn: (filePath: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'ff-workflow-id-writeback-'));
    const filePath = join(dir, 'flow.ff.ts');
    writeFileSync(filePath, content, 'utf-8');
    try {
      fn(filePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('stamps the workflowId into the file on the success path', () => {
    withTempFile(OBJECT_FORM, (filePath) => {
      const result = writeFlowWorkflowId(filePath, GUID);
      assert.equal(result, true);

      const updated = readFileSync(filePath, 'utf-8');
      assert.match(updated, /workflowId:\s*"11111111-2222-3333-4444-555555555555"/);
    });
  });

  it('leaves the file byte-identical when there is no editable @Flow decorator', () => {
    const original = 'export class NotAFlow {}\n';
    withTempFile(original, (filePath) => {
      const before = readFileSync(filePath);
      const result = writeFlowWorkflowId(filePath, GUID);
      assert.equal(result, false);

      const after = readFileSync(filePath);
      assert.ok(before.equals(after), 'file bytes must be unchanged when the write is skipped');
    });
  });
});
