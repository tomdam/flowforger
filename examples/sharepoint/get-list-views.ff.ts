@Flow("SharePoint Get List Views")
class SharePoint_Get_List_Views {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    // Configuration for this example - edit to point at your own tenant.
    // In a production flow, prefer a flow parameter bound to an environment
    // variable (ctx.parameters("...")), or values passed in via the trigger payload.
    let siteUrl = "https://contoso.sharepoint.com/sites/MySite";
    let listId = "aaaaaaaa-1111-2222-3333-444444444444";

    await ctx.connectors.sharepoint.GetListViews("GetListViews", {
      dataset: ctx.variables("siteUrl"),
      table: ctx.variables("listId")
    });
    await ctx.filterArray("Get default view", ctx.body('GetListViews').value, "@equals(item().DefaultView, true)");
    await ctx.filterArray("Get visible views only", ctx.body('GetListViews').value, "@equals(item().Hidden, false)");
    await ctx.compose("ViewSummary", {
      totalViews: ctx.body('GetListViews').value.length,
      defaultView: ctx.first(ctx.body('Get default view')).Title,
      visibleViews: ctx.body('Get visible views only').length,
      allViews: ctx.body('GetListViews').value
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
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}