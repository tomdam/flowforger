@Flow("SharePoint Get List Views")
class SharePoint_Get_List_Views {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetListViews("Get list views", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      table: "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}"
    });
    /** @runAfter trigger */
    await ctx.filterArray("Get default view", ctx.body('Get list views').value, "@equals(item().DefaultView, true)");
    /** @runAfter trigger */
    await ctx.filterArray("Get visible views only", ctx.body('Get list views').value, "@equals(item().Hidden, false)");
    /** @runAfter trigger */
    await ctx.compose("View summary", {
      totalViews: ctx.body('Get list views').value.length,
      defaultView: ctx.first(ctx.body('Get default view')).Title,
      visibleViews: ctx.body('Get visible views only').length,
      allViews: ctx.body('Get list views').value
    });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
      contentVersion: "1.0.0.0",
      schemaVersion: "1.0.0.0",
    };
    ctx.flow.connectionReferences = {
      shared_sharepointonline: {
        runtimeUrl: '',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}