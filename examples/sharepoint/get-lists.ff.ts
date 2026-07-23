@Flow("SharePoint Get All Lists and Libraries")
class SharePoint_Get_All_Lists_and_Libraries {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetLists("GetAllListsAndLibraries", { dataset: "https://contoso.sharepoint.com/sites/MySite" });
    /** @runAfter trigger */
    await ctx.filterArray("Filter to document libraries only", ctx.body('GetAllListsAndLibraries').value, "@equals(item().BaseType, 1)");
    /** @runAfter trigger */
    await ctx.filterArray("Filter to visible lists only", ctx.body('GetAllListsAndLibraries').value, "@equals(item().Hidden, false)");
    /** @runAfter trigger */
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