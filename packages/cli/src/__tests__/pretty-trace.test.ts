import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transformCode } from "@flowforger/dsl-native";
import { run } from "@flowforger/engine";
import { formatPrettyRunResult } from "../pretty-trace.js";

async function prettyRun(dsl: string): Promise<string[]> {
  const ir = transformCode(dsl);
  const result = await run(ir, { input: {} });
  return formatPrettyRunResult(ir.name, result, { color: false });
}

describe("pretty run output", () => {
  it("prints an if before the branch that ran, with the branch indented under it", async () => {
    const lines = await prettyRun(`
@Flow('welcome-flow')
class WelcomeFlow {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('Member', 'Alice');
    if (ctx.outputs('Member') === 'Alice') {
      await ctx.compose('Note', 'Welcome back!');
    } else {
      await ctx.compose('Note2', 'Welcome!');
    }
  }
}
`);

    assert.deepEqual(lines, [
      "",
      "▶ welcome-flow",
      "",
      "  ⚡ manual (trigger)",
      '  ✓ Member → "Alice"',
      "  ✓ Check_Member condition → true (then branch)",
      '    ✓ Note → "Welcome back!"',
      "",
      "✓ Flow succeeded — 3 actions executed",
      "",
    ]);
  });

  it("nests scope and switch bodies, and ifs inside loop iterations", async () => {
    const lines = await prettyRun(`
@Flow('mixed-flow')
class MixedFlow {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('Region', 'EU');
    /** @action Work @type scope */
    {
      await ctx.compose('InScope', 1);
      /** @action RouteByRegion */
      switch (ctx.outputs('Region')) {
        /** @action CaseUS */
        case 'US':
          await ctx.compose('TaxUS', 0.08);
          break;
        /** @action CaseEU */
        case 'EU':
          await ctx.compose('TaxEU', 0.2);
          break;
      }
    }
    /** @action Loop */
    for (const x of ctx.createArray(1, 2)) {
      /** @action IsOne */
      if (x === 1) {
        await ctx.compose('One', x);
      }
    }
  }
}
`);

    assert.deepEqual(lines.slice(3, -3), [
      "  ⚡ manual (trigger)",
      '  ✓ Region → "EU"',
      '  ✓ Work → {"scopeStatus":"Succeeded"}',
      "    ✓ InScope → 1",
      '    ✓ RouteByRegion → {"matched":true,"matchedCase":"CaseEU","value":"EU"}',
      "      ✓ TaxEU → 0.2",
      "      ↷ TaxUS",
      "  ✓ Loop — 2 iterations",
      "    [1/2] 1",
      "      ✓ IsOne condition → true (then branch)",
      "        ✓ One → 1",
      "    [2/2] 2",
      "      ✓ IsOne condition → false (else branch)",
    ]);
  });

  it("counts nested actions once each", async () => {
    const lines = await prettyRun(`
@Flow('count-flow')
class CountFlow {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Outer @type scope */
    {
      await ctx.compose('A', 1);
      /** @action Inner @type scope */
      {
        await ctx.compose('B', 2);
      }
    }
  }
}
`);

    // Outer, A, Inner, B
    assert.ok(lines.includes("✓ Flow succeeded — 4 actions executed"), lines.join("\n"));
  });

  it("labels connector records by their title and prints list results as a count", async () => {
    const record = (id: number, title: string) => ({
      Author: { "@odata.type": "#Microsoft.Azure.Connectors.SharePoint.SPListExpandedUser", Claims: "i:0#.f|x" },
      ID: id,
      Title: title,
    });
    const result = {
      status: "Succeeded",
      trace: [
        { nodeId: "trg_1", name: "Recurrence", status: "Succeeded" },
        {
          nodeId: "con_1",
          name: "Get_open_invoices",
          status: "Succeeded",
          outputs: { body: { "@odata.nextLink": "x", value: [record(1, "INV-1041"), record(3, "INV-1043")] } },
        },
        {
          nodeId: "fe_1",
          name: "ForEach_invoice",
          status: "Succeeded",
          iterations: [
            { index: 0, item: record(1, "INV-1041"), actions: [] },
            { index: 1, item: { id: 7, displayName: "Finance" }, actions: [] },
            { index: 2, item: { a: 1 }, actions: [] },
          ],
        },
        { nodeId: "con_2", name: "One", status: "Succeeded", outputs: { body: { value: [record(1, "x")] } } },
        { nodeId: "act_1", name: "NotACollection", status: "Succeeded", outputs: { value: [1], other: true } },
      ],
    };
    const lines = formatPrettyRunResult("f", result, { color: false });
    assert.deepEqual(lines.slice(4, 11), [
      "  ✓ Get_open_invoices → 2 items",
      "  ✓ ForEach_invoice — 3 iterations",
      '    [1/3] "INV-1041"',
      '    [2/3] "Finance"',
      '    [3/3] {"a":1}',
      "  ✓ One → 1 item",
      '  ✓ NotACollection → {"value":[1],"other":true}',
    ]);
  });

  it("shows a failed nested action's error under it", async () => {
    const result = {
      status: "Failed",
      trace: [
        { nodeId: "trg_1", name: "manual", status: "Succeeded" },
        {
          nodeId: "scp_1",
          name: "Try",
          status: "Failed",
          outputs: { scopeStatus: "Failed" },
          children: [{ nodeId: "con_1", name: "Call", status: "Failed", error: new Error("boom") }],
        },
      ],
    };
    const lines = formatPrettyRunResult("f", result, { color: false });
    assert.deepEqual(lines.slice(4, 7), ['  ✗ Try → {"scopeStatus":"Failed"}', "    ✗ Call", "      boom"]);
  });
});
