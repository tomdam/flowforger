/**
 * Tests for completion context analysis, in particular that string-reference
 * contexts (variables/body/items/parameters/…) match with a partially typed
 * name after the opening quote — the mid-word Ctrl+Space case — and never
 * match once the string is closed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { analyzeCompletionContext, CompletionType } from '../src/providers/completion.js';

describe('analyzeCompletionContext', () => {
  describe('string-reference contexts', () => {
    it('matches variables( right after the opening quote', () => {
      const result = analyzeCompletionContext("  const v = ctx.variables('");
      assert.strictEqual(result.type, CompletionType.VariableName);
    });

    it('matches variables( with a partially typed name', () => {
      const result = analyzeCompletionContext("  const v = ctx.variables('cou");
      assert.strictEqual(result.type, CompletionType.VariableName);
    });

    it('matches variables( with double quotes and a partial name', () => {
      const result = analyzeCompletionContext('  const v = ctx.variables("cou');
      assert.strictEqual(result.type, CompletionType.VariableName);
    });

    it('does not match after the string is closed', () => {
      const result = analyzeCompletionContext("  const v = ctx.variables('counter')");
      assert.strictEqual(result.type, CompletionType.None);
    });

    it('does not match right after the closing quote', () => {
      const result = analyzeCompletionContext("  const v = ctx.variables('counter'");
      assert.strictEqual(result.type, CompletionType.None);
    });

    it('matches body( with a partial name', () => {
      const result = analyzeCompletionContext("  const r = ctx.body('Fetch");
      assert.strictEqual(result.type, CompletionType.ActionName);
    });

    it('matches outputs( with a partial name', () => {
      const result = analyzeCompletionContext("  const r = ctx.outputs('Fetch");
      assert.strictEqual(result.type, CompletionType.ActionName);
    });

    it('matches items( with a partial name', () => {
      const result = analyzeCompletionContext("  const i = ctx.items('Loop");
      assert.strictEqual(result.type, CompletionType.LoopName);
    });

    it('matches parameters( with a partial name', () => {
      const result = analyzeCompletionContext("  const p = ctx.parameters('Site");
      assert.strictEqual(result.type, CompletionType.ParameterName);
    });

    it('matches a nested variables( inside another call argument', () => {
      const result = analyzeCompletionContext("  await ctx.compose('Result', ctx.variables('gre");
      assert.strictEqual(result.type, CompletionType.VariableName);
    });

    it('does not match a closed reference followed by an unrelated string', () => {
      const result = analyzeCompletionContext("  const s = ctx.variables('a') + 'cou");
      assert.strictEqual(result.type, CompletionType.None);
    });
  });

  describe('child flow and connection reference contexts', () => {
    it('matches callWorkflow second argument with a partial name', () => {
      const result = analyzeCompletionContext("  await ctx.callWorkflow('Call', 'Chi");
      assert.strictEqual(result.type, CompletionType.ChildFlowName);
    });

    it('matches connection reference with a partial name', () => {
      const result = analyzeCompletionContext(
        "  await ctx.connectors.sharepoint.GetItems('Get', { dataset: 'x', table: 'y' }, 'shared_share"
      );
      assert.strictEqual(result.type, CompletionType.ConnectionReferenceName);
    });
  });

  describe('member access contexts (unchanged)', () => {
    it('matches ctx. for context methods', () => {
      const result = analyzeCompletionContext('  await ctx.');
      assert.strictEqual(result.type, CompletionType.ContextMethods);
    });

    it('matches ctx.connectors. for connector names', () => {
      const result = analyzeCompletionContext('  await ctx.connectors.');
      assert.strictEqual(result.type, CompletionType.ConnectorNames);
    });

    it('returns None for a plain identifier position', () => {
      const result = analyzeCompletionContext('  counter = cou');
      assert.strictEqual(result.type, CompletionType.None);
    });
  });
});
