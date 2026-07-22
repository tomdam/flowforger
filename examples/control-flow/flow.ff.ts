/**
 * Example: Control Flow Demo
 *
 * Demonstrates scope (grouped actions), if/else branching, and foreach iteration
 * over a variable, in a single small flow.
 */

@Flow('control-flow-demo')
class ControlFlowDemo {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    let x: number = 1;
    let items: any[] = [];

    await ctx.http('First', { method: 'GET', url: 'https://example.com' });

    /** @action ScopeOne @type scope */
    {
      await ctx.http('InnerA', { method: 'GET', url: 'https://example.com' });
      await ctx.http('InnerB', { method: 'GET', url: 'https://example.com' });
    }

    /** @action CheckX @type if */
    if (ctx.eval(`@equals(variables('x'), 1)`)) {
      await ctx.http('ThenA', { method: 'GET', url: 'https://example.com' });
    } else {
      await ctx.http('ElseA', { method: 'GET', url: 'https://example.com' });
    }

    /** @action LoopItems @type foreach */
    for (const _item of ctx.variables('items') ?? []) {
      await ctx.http('PerItem', { method: 'GET', url: 'https://example.com' });
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
