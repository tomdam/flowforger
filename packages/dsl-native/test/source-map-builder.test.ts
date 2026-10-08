/**
 * Tests for buildSourceMapFromDsl — the map the debuggers (VS Code, web, MCP) use to
 * report the paused line and to resolve line breakpoints. A node without an entry
 * pauses on `line: null` and can't be broken on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlowIR } from '@flowforger/ir';
import { transformCode } from '../src/transformer/index.js';
import { buildSourceMapFromDsl, collectAllNodes } from '../src/source-map-builder.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Start line and the trimmed source text there, per node name. */
function linesByName(dsl: string): Record<string, { start: number; end: number; text: string }> {
  const ir = transformCode(dsl) as FlowIR;
  const map = buildSourceMapFromDsl(dsl, ir);
  const lines = dsl.split('\n');
  const out: Record<string, { start: number; end: number; text: string }> = {};
  for (const node of collectAllNodes(ir.nodes)) {
    const entry = map.nodeIdToLines.get(node.id);
    if (entry) out[node.name] = { start: entry.startLine, end: entry.endLine, text: lines[entry.startLine - 1].trim() };
  }
  return out;
}

describe('buildSourceMapFromDsl', () => {
  it('maps a call whose action name is on the next line', () => {
    const m = linesByName(`
@Flow('T')
class T {
  @ManualTrigger()
  trigger(ctx: FlowContext) {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.response(
      "Respond_multi",
      200,
      { ok: true }
    );
    await ctx.compose("After", "x");
  }
}
`);
    assert.equal(m.Respond_multi.text, 'await ctx.response(');
    assert.equal(m.Respond_multi.end - m.Respond_multi.start, 4);
    assert.equal(m.After.text, 'await ctx.compose("After", "x");');
  });

  it('maps untagged switch, if, else if, for...of and do...while statements', () => {
    const m = linesByName(`
@Flow('T')
class T {
  @ManualTrigger()
  trigger(ctx: FlowContext) {}

  @Action()
  async run(ctx: FlowContext) {
    switch (ctx.eval(\`@triggerBody()?['mode']\`)) {
      /** @action Case_a @type case */
      case 'a':
        await ctx.compose("In_a", "a");
      default:
        await ctx.compose("In_default", "d");
    }
    if (ctx.eval(\`@equals(1, 1)\`)) {
      await ctx.compose("Then_1", "t");
    } else if (ctx.eval(\`@equals(2, 2)\`)) {
      await ctx.compose("Then_2", "t");
    }
    for (const item of ctx.eval(\`@createArray(1, 2)\`)) {
      await ctx.compose("Each", "e");
    }
    let n: number = 0;
    do {
      n++;
    } while (ctx.variables('n') < 3);
  }
}
`);
    const byType = (prefix: string) => Object.entries(m).filter(([, v]) => v.text.startsWith(prefix));
    assert.equal(byType('switch (').length, 1);
    assert.equal(byType('if (').length, 1);
    assert.equal(byType('} else if (').length, 1);
    assert.equal(byType('for (const item').length, 1);
    assert.equal(byType('do {').length, 1);

    // The else-if spans only its own branch, not past the closing brace of the if
    const [, elseIf] = byType('} else if (')[0];
    assert.equal(elseIf.end - elseIf.start, 2);
    assert.equal(m.Then_2.start, elseIf.start + 1);
  });

  it('maps x++ / x-- and appendToStringVariable without claiming the initializer', () => {
    const m = linesByName(`
@Flow('T')
class T {
  @ManualTrigger()
  trigger(ctx: FlowContext) {}

  @Action()
  async run(ctx: FlowContext) {
    let count = 0;
    let text: string = 'a';
    count = count + 1;
    count++;
    --count;
    await ctx.appendToStringVariable('text', 'b');
  }
}
`);
    const texts = Object.fromEntries(Object.values(m).map((v) => [v.text, true]));
    for (const line of ['let count = 0;', "let text: string = 'a';", 'count = count + 1;', 'count++;', '--count;',
      "await ctx.appendToStringVariable('text', 'b');"]) {
      assert.ok(texts[line], `no node mapped to "${line}"`);
    }
    assert.equal(Object.keys(m).filter((k) => k.startsWith('Initialize_count')).map((k) => m[k].text)[0], 'let count = 0;');
  });

  it('spans a tagged block whose JSDoc carries braces of its own', () => {
    const m = linesByName(`
@Flow('T')
class T {
  @ManualTrigger()
  trigger(ctx: FlowContext) {}

  @Action()
  async run(ctx: FlowContext) {
    let n: number = 0;
    /** @action Until_limit @limit {"count":3,"timeout":"PT1M"} */
    do {
      n++;
      await ctx.compose("Step", ctx.variables('n'));
    } while (ctx.variables('n') < 100);
  }
}
`);
    assert.equal(m.Until_limit.end - m.Until_limit.start, 4);
  });

  it('maps every node of every conformance and example flow', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (f === 'node_modules' || f === 'dist') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.ff.ts')) files.push(p);
      }
    };
    walk(join(REPO, 'conformance', 'flows'));
    walk(join(REPO, 'examples'));
    assert.ok(files.length > 50, `expected the flow corpus, found ${files.length} files`);

    const unmapped: string[] = [];
    for (const file of files) {
      const dsl = readFileSync(file, 'utf8');
      const ir = transformCode(dsl) as FlowIR;
      const map = buildSourceMapFromDsl(dsl, ir);
      for (const node of collectAllNodes(ir.nodes)) {
        if (!map.nodeIdToLines.has(node.id)) unmapped.push(`${file.slice(REPO.length + 1)}: ${node.name}`);
      }
    }
    assert.deepEqual(unmapped, []);
  });
});
