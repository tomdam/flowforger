@Flow("SharePoint Get All Lists and Libraries")
class SharePoint_Get_All_Lists_and_Libraries {
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

    await ctx.connectors.sharepoint.GetLists("GetAllListsAndLibraries", { dataset: ctx.variables("siteUrl") });
    await ctx.filterArray("Filter to document libraries only", ctx.body('GetAllListsAndLibraries').value, "@equals(item().BaseType, 1)");
    await ctx.filterArray("Filter to visible lists only", ctx.body('GetAllListsAndLibraries').value, "@equals(item().Hidden, false)");
    await ctx.compose("Summary", {
      totalLists: ctx.body('GetAllListsAndLibraries').value.length,
      documentLibraries: ctx.body('Filter to document libraries only').length,
      visibleLists: ctx.body('Filter to visible lists only').length,
      lists: ctx.body('GetAllListsAndLibraries').value
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