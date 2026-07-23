@Flow("SharePoint Get Item Changes Example")
class SharePoint_Get_Item_Changes_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        libraryId: { type: "string", description: "The library GUID" },
        itemId: { type: "string", description: "The list item ID" },
        since: { type: "string", description: "Start date (ISO format)" }
      }
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetItemChanges("GetItemChanges", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['libraryId'],
      itemId: ctx.triggerBody()?.['itemId'],
      since: ctx.triggerBody()?.['since']
    });
    /** @runAfter trigger */
    await ctx.compose("ShowVersionHistory", {
      versionCount: ctx.outputs('GetItemChanges')?.['value'].length,
      versions: ctx.outputs('GetItemChanges')?.['value']
    });
    /** @action CheckIfChangesExist @type if @runAfter trigger */
    if ((ctx.outputs('GetItemChanges')?.['value'].length > 0)) {
      await ctx.compose("LatestChange", ctx.first(ctx.outputs('GetItemChanges')?.['value']));
    }
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