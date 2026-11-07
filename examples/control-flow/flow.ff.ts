/**
 * Example: Control Flow Demo
 *
 * Demonstrates a scope (grouped actions), if/else branching on a variable, and a
 * foreach over an array variable, in one small flow. The actions are Compose
 * actions, so the flow runs locally without network access or credentials.
 */

@Flow('control-flow-demo')
class ControlFlowDemo {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize_x */
    let x: number = 1;

    /** @action Initialize_items */
    let items: any[] = [];

    await ctx.compose('First', 'runs before the scope');

    // A scope groups actions; it needs @type scope because a bare block is ambiguous
    /** @action ScopeOne @type scope */
    {
      await ctx.compose('InnerA', 'first action in the scope');
      await ctx.compose('InnerB', 'second action in the scope');
    }

    // A TypeScript comparison compiles to the Condition action's expression
    /** @action CheckX */
    if (ctx.variables('x') === 1) {
      await ctx.compose('ThenA', 'x is 1');
    } else {
      await ctx.compose('ElseA', 'x is not 1');
    }

    // A for...of over an array compiles to Apply to each; `item` is the current element
    /** @action LoopItems */
    for (const item of ctx.variables('items') ?? []) {
      await ctx.compose('PerItem', { item: item, doubled: ctx.mul(item, 2) });
    }
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      schemaVersion: '1.0.0.0',
    };
    ctx.flow.connectionReferences = {};
    ctx.flow.parameters = {
      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },
    };
  }
}
