/**
 * Example: Optimizer output — generated from unoptimized.ff.ts by `flowforger optimize`.
 * The 'status' variable became a Compose and the loop+append became a Select action.
 * See report.json for the machine-readable change report.
 */
@Flow("OptimizerTest")
class OptimizerTest {
  @HttpTrigger()
  trigger(ctx: FlowContext) {
    return {
      method: "POST",
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    // This variable is never modified - should become compose
    await ctx.compose("Initialize_status", "active");
    // Get some items to process
    await ctx.http("GetItems", { method: "GET", url: "https://api.example.com/items" });
    await ctx.select("results", ctx.body('GetItems'), { id: ctx.item().id, name: ctx.item().name, processed: true });
    // Use the variables
    await ctx.response("Response", 200, {
      status: ctx.outputs('Initialize_status'),
      results: ctx.body('results')
    });
  }
}