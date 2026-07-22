/**
 * Tests for the native DSL transformer
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { transformCode } from '../src/transformer/index.js';
import { resetIdCounter } from '../src/utils/id-generator.js';
import { generateNativeDslFromIR } from '../src/generator.js';
import type { FlowIR } from '@flowforger/ir';

describe('transformCode', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('should transform a simple flow with HTTP trigger', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('TestFlow')
      class TestFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.compose('Result', { message: 'Hello' });
        }
      }
    `;

    const ir = transformCode(code);

    assert.strictEqual(ir.name, 'TestFlow');
    assert.strictEqual(ir.nodes.length, 2);
    assert.strictEqual(ir.nodes[0].type, 'trigger');
    assert.strictEqual((ir.nodes[0] as any).kind, 'http');
    assert.strictEqual(ir.nodes[1].type, 'action');
    assert.strictEqual((ir.nodes[1] as any).kind, 'compose');
    assert.strictEqual(ir.nodes[1].name, 'Result');
  });

  it('should transform variable declarations', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('VarFlow')
      class VarFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          let counter = 0;
          counter = 5;
        }
      }
    `;

    const ir = transformCode(code);

    assert.strictEqual(ir.nodes.length, 3);
    // Node 0: trigger
    // Node 1: InitializeVariable
    assert.strictEqual((ir.nodes[1] as any).kind, 'initializevariable');
    assert.strictEqual((ir.nodes[1] as any).inputs.variableName, 'counter');
    assert.strictEqual((ir.nodes[1] as any).inputs.variableType, 'integer');
    assert.strictEqual((ir.nodes[1] as any).inputs.value, 0);
    // Node 2: SetVariable
    assert.strictEqual((ir.nodes[2] as any).kind, 'setvariable');
    assert.strictEqual((ir.nodes[2] as any).inputs.name, 'counter');
    assert.strictEqual((ir.nodes[2] as any).inputs.value, 5);
  });

  it('should transform if statements to IfNode', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('IfFlow')
      class IfFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          if (ctx.body('GetData').active === true) {
            await ctx.compose('ThenBranch', 'yes');
          } else {
            await ctx.compose('ElseBranch', 'no');
          }
        }
      }
    `;

    const ir = transformCode(code);

    assert.strictEqual(ir.nodes.length, 2);
    assert.strictEqual(ir.nodes[1].type, 'if');
    const ifNode = ir.nodes[1] as any;
    assert.ok(ifNode.condition.includes('equals'));
    assert.strictEqual(ifNode.actions.length, 1);
    assert.strictEqual(ifNode.actions[0].name, 'ThenBranch');
    assert.strictEqual(ifNode.elseActions.length, 1);
    assert.strictEqual(ifNode.elseActions[0].name, 'ElseBranch');
  });

  it('should transform for...of loops to ForeachNode', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('LoopFlow')
      class LoopFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          for (const item of ctx.body('GetItems').value) {
            await ctx.compose('ProcessItem', ctx.item());
          }
        }
      }
    `;

    const ir = transformCode(code);

    assert.strictEqual(ir.nodes.length, 2);
    assert.strictEqual(ir.nodes[1].type, 'foreach');
    const foreachNode = ir.nodes[1] as any;
    assert.ok(foreachNode.itemsExpression.includes("body('GetItems')"));
    assert.strictEqual(foreachNode.actions.length, 1);
    assert.strictEqual(foreachNode.actions[0].name, 'ProcessItem');
  });

  it('should transform switch statements to SwitchNode', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('SwitchFlow')
      class SwitchFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          switch (ctx.body('GetUser').role) {
            case 'admin':
              await ctx.compose('IsAdmin', true);
              break;
            case 'user':
              await ctx.compose('IsUser', true);
              break;
            default:
              await ctx.compose('IsGuest', true);
          }
        }
      }
    `;

    const ir = transformCode(code);

    assert.strictEqual(ir.nodes.length, 2);
    assert.strictEqual(ir.nodes[1].type, 'switch');
    const switchNode = ir.nodes[1] as any;
    assert.strictEqual(switchNode.cases.length, 2);
    assert.strictEqual(switchNode.cases[0].value, 'admin');
    assert.strictEqual(switchNode.cases[1].value, 'user');
    assert.ok(switchNode.defaultActions);
    assert.strictEqual(switchNode.defaultActions.length, 1);
  });

  it('should transform HTTP actions', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('HttpFlow')
      class HttpFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.http('CallAPI', {
            method: 'GET',
            url: 'https://api.example.com/data',
            headers: { 'Accept': 'application/json' },
          });
        }
      }
    `;

    const ir = transformCode(code);

    assert.strictEqual(ir.nodes.length, 2);
    const httpNode = ir.nodes[1] as any;
    assert.strictEqual(httpNode.type, 'action');
    assert.strictEqual(httpNode.kind, 'http');
    assert.strictEqual(httpNode.name, 'CallAPI');
    assert.strictEqual(httpNode.inputs.method, 'GET');
    assert.strictEqual(httpNode.inputs.url, 'https://api.example.com/data');
  });

  it('should extract childFlows from constructor', () => {
    const code = `
      import { Flow, ManualTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('ParentFlow')
      class ParentFlow {
        @ManualTrigger()
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.callWorkflow('CallChild', 'MyChildFlow', { text: 'hello' });
        }

        constructor(ctx: FlowContext) {
          ctx.flow.childFlows = {
            MyChildFlow: {
              workflowId: 'fa05dee0-12d5-f011-8544-7c1e523655f2',
              description: 'A child flow',
              parameters: {
                text: { title: 'Input Text', type: 'string', required: true },
              },
            },
          };
        }
      }
    `;

    const ir = transformCode(code);
    assert.ok(ir.childFlows, 'childFlows should be present on IR');
    assert.ok(ir.childFlows.MyChildFlow, 'MyChildFlow should be defined');
    assert.strictEqual(ir.childFlows.MyChildFlow.workflowId, 'fa05dee0-12d5-f011-8544-7c1e523655f2');
    assert.strictEqual(ir.childFlows.MyChildFlow.description, 'A child flow');
    assert.ok(ir.childFlows.MyChildFlow.parameters?.text, 'text parameter should exist');
    assert.strictEqual(ir.childFlows.MyChildFlow.parameters!.text.title, 'Input Text');
    assert.strictEqual(ir.childFlows.MyChildFlow.parameters!.text.type, 'string');
    assert.strictEqual(ir.childFlows.MyChildFlow.parameters!.text.required, true);
  });

  it('should extract class JSDoc comment as flow description', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      /**
       * Example: My Test Flow
       *
       * This flow does something useful.
       *
       * Strategy: Step by step.
       */
      @Flow('TestFlow')
      class TestFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.compose('Result', { message: 'Hello' });
        }
      }
    `;

    const ir = transformCode(code);

    assert.strictEqual(ir.description, 'Example: My Test Flow\n\nThis flow does something useful.\n\nStrategy: Step by step.');
  });

  it('should prefer @Flow({ description }) over class JSDoc', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      /**
       * JSDoc description that should be ignored.
       */
      @Flow({ name: 'TestFlow', description: 'Decorator description wins' })
      class TestFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.compose('Result', { message: 'Hello' });
        }
      }
    `;

    const ir = transformCode(code);

    assert.strictEqual(ir.description, 'Decorator description wins');
  });

  it('should have no description when no JSDoc and no decorator description', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('TestFlow')
      class TestFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.compose('Result', { message: 'Hello' });
        }
      }
    `;

    const ir = transformCode(code);

    assert.strictEqual(ir.description, undefined);
  });

  it('should extract file-level JSDoc as description fallback', () => {
    const code = `
    /**
     * File-level description above imports.
     *
     * This should be used as fallback.
     */
    import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

    @Flow('TestFlow')
    class TestFlow {
      @HttpTrigger({ method: 'POST' })
      trigger() {}

      @Action()
      async run(ctx: FlowContext) {
        await ctx.compose('Result', { message: 'Hello' });
      }
    }
  `;

    const ir = transformCode(code);

    assert.strictEqual(ir.description, 'File-level description above imports.\n\nThis should be used as fallback.');
  });

  it('should prefer class JSDoc over file-level JSDoc', () => {
    const code = `
    /**
     * File-level description (should be ignored).
     */
    import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

    /**
     * Class-level description wins.
     */
    @Flow('TestFlow')
    class TestFlow {
      @HttpTrigger({ method: 'POST' })
      trigger() {}

      @Action()
      async run(ctx: FlowContext) {
        await ctx.compose('Result', { message: 'Hello' });
      }
    }
  `;

    const ir = transformCode(code);

    assert.strictEqual(ir.description, 'Class-level description wins.');
  });
});

describe('generateNativeDslFromIR — flow description', () => {
  it('should emit description as JSDoc comment above the class', () => {
    const ir: FlowIR = {
      name: 'TestFlow',
      description: 'My flow description\n\nWith multiple lines.',
      nodes: [
        {
          id: 'trg_1',
          name: 'manual_trigger',
          type: 'trigger' as const,
          kind: 'http' as const,
          inputs: { method: 'POST' },
        },
        {
          id: 'act_1',
          name: 'Result',
          type: 'action' as const,
          kind: 'compose' as const,
          inputs: { value: 'Hello' },
        },
      ],
    };

    const dsl = generateNativeDslFromIR(ir);

    // Should have JSDoc comment
    assert.ok(dsl.includes('/**'), 'Should contain JSDoc opening');
    assert.ok(dsl.includes(' * My flow description'), 'Should contain first line');
    assert.ok(dsl.includes(' * With multiple lines.'), 'Should contain second paragraph');
    assert.ok(dsl.includes(' */'), 'Should contain JSDoc closing');

    // Should NOT have description in decorator
    assert.ok(!dsl.includes('description:'), 'Should not have description in decorator');
    assert.ok(dsl.includes('@Flow("TestFlow")'), 'Should use simple string form');
  });

  it('should not emit JSDoc when no description', () => {
    const ir: FlowIR = {
      name: 'TestFlow',
      nodes: [
        {
          id: 'trg_1',
          name: 'manual_trigger',
          type: 'trigger' as const,
          kind: 'http' as const,
          inputs: { method: 'POST' },
        },
        {
          id: 'act_1',
          name: 'Result',
          type: 'action' as const,
          kind: 'compose' as const,
          inputs: { value: 'Hello' },
        },
      ],
    };

    const dsl = generateNativeDslFromIR(ir);

    // Check that there's no JSDoc immediately before @Flow
    const lines = dsl.split('\n');
    const flowLine = lines.findIndex(l => l.includes('@Flow('));
    // Previous non-empty line should not be */
    const prevLine = lines.slice(0, flowLine).reverse().find(l => l.trim() !== '');
    assert.ok(!prevLine || !prevLine.trim().endsWith('*/'), 'Should not have JSDoc before @Flow');
  });

  it('should round-trip description: DSL → IR → DSL → IR', () => {
    const originalCode = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      /**
       * My Flow Description
       *
       * It does important things.
       */
      @Flow('RoundTripFlow')
      class RoundTripFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.compose('Result', { message: 'Hello' });
        }
      }
    `;

    // DSL → IR (first pass)
    const ir1 = transformCode(originalCode);
    assert.strictEqual(ir1.description, 'My Flow Description\n\nIt does important things.');

    // IR → DSL (generate)
    const generatedDsl = generateNativeDslFromIR(ir1);

    // DSL → IR (second pass)
    const ir2 = transformCode(generatedDsl);
    assert.strictEqual(ir2.description, ir1.description, 'Description should survive round-trip');
  });
});

describe('@Flow workflowId extraction', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('should extract workflowId from @Flow object literal', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow({
        name: 'TestFlow',
        workflowId: '11111111-2222-3333-4444-555555555555'
      })
      class TestFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.compose('Result', { message: 'Hello' });
        }
      }
    `;

    const ir = transformCode(code);
    assert.strictEqual(ir.workflowId, '11111111-2222-3333-4444-555555555555');
    assert.strictEqual(ir.name, 'TestFlow');
  });

  it('should leave workflowId undefined when @Flow uses string form', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow('TestFlow')
      class TestFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.compose('Result', { message: 'Hello' });
        }
      }
    `;

    const ir = transformCode(code);
    assert.strictEqual(ir.workflowId, undefined);
  });

  it('should leave workflowId undefined when @Flow object literal omits it', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow({ name: 'TestFlow' })
      class TestFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.compose('Result', { message: 'Hello' });
        }
      }
    `;

    const ir = transformCode(code);
    assert.strictEqual(ir.workflowId, undefined);
  });

  it('should throw a clear error when workflowId is not a string literal', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      const dynamicId = 'abc';

      @Flow({
        name: 'TestFlow',
        workflowId: dynamicId
      })
      class TestFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.compose('Result', { message: 'Hello' });
        }
      }
    `;

    assert.throws(
      () => transformCode(code),
      /workflowId must be a string literal GUID/
    );
  });
});

describe('generateNativeDslFromIR @Flow workflowId emission', () => {
  it('should emit @Flow object form with workflowId when ir.workflowId is set', () => {
    const ir: FlowIR = {
      name: 'TestFlow',
      workflowId: '11111111-2222-3333-4444-555555555555',
      nodes: [
        { type: 'trigger', kind: 'http', id: 'trg_1', name: 'manual', inputs: { method: 'POST' } } as any,
      ],
    };

    const code = generateNativeDslFromIR(ir);
    assert.match(
      code,
      /@Flow\(\{\s*name:\s*["']TestFlow["'],\s*workflowId:\s*["']11111111-2222-3333-4444-555555555555["']\s*\}\)/
    );
  });

  it('should keep @Flow short string form when ir.workflowId is not set', () => {
    const ir: FlowIR = {
      name: 'TestFlow',
      nodes: [
        { type: 'trigger', kind: 'http', id: 'trg_1', name: 'manual', inputs: { method: 'POST' } } as any,
      ],
    };

    const code = generateNativeDslFromIR(ir);
    assert.match(code, /@Flow\(["']TestFlow["']\)/);
    assert.doesNotMatch(code, /workflowId/);
  });

  it('should preserve workflowId through DSL round-trip (transform → generate → transform)', () => {
    const code = `
      import { Flow, HttpTrigger, Action, FlowContext } from '@flowforger/dsl-native';

      @Flow({
        name: 'RoundTripFlow',
        workflowId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      })
      class RoundTripFlow {
        @HttpTrigger({ method: 'POST' })
        trigger() {}

        @Action()
        async run(ctx: FlowContext) {
          await ctx.compose('Result', { message: 'Hello' });
        }
      }
    `;

    const ir1 = transformCode(code);
    assert.strictEqual(ir1.workflowId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const generated = generateNativeDslFromIR(ir1);

    const ir2 = transformCode(generated);
    assert.strictEqual(ir2.workflowId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});
