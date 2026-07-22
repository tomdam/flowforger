/**
 * Example: Optimizer input — a flow with two optimization opportunities:
 * 1. Single-set variable ('status') — never modified after init, can become a Compose
 * 2. Append-to-array in a loop ('results') — can become a Select action (enables parallelism)
 *
 * Run `flowforger optimize` on this file to produce optimized.ff.ts (see README.md).
 */
@Flow('OptimizerTest')
class OptimizerTest {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    // This variable is never modified - should become compose
    let status: string = 'active';

    // Get some items to process
    const items = await ctx.http('GetItems', {
      method: 'GET',
      url: 'https://api.example.com/items',
    });

    // This is the append-to-array pattern - should become select
    let results: any[] = [];
    for (const item of ctx.body('GetItems')) {
      results.push({
        id: ctx.item().id,
        name: ctx.item().name,
        processed: true,
      });
    }

    // Use the variables
    await ctx.response('Response', 200, {
      status: ctx.variables('status'),
      results: ctx.variables('results'),
    });
  }
}
