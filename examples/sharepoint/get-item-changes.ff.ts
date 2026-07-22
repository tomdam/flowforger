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
    await ctx.connectors.sharepoint.GetItemChanges("Get Item Changes", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['libraryId'],
      itemId: ctx.triggerBody()?.['itemId'],
      since: ctx.triggerBody()?.['since']
    });
    /** @runAfter trigger */
    await ctx.compose("Show Version History", {
      versionCount: ctx.outputs('Get Item Changes')?.['value'].length,
      versions: ctx.outputs('Get Item Changes')?.['value']
    });
    /** @action Check if Changes Exist @type if @runAfter trigger */
    if ((ctx.outputs('Get Item Changes')?.['value'].length > 0)) {
      await ctx.compose("Latest Change", ctx.first(ctx.outputs('Get Item Changes')?.['value']));
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
        runtimeUrl: '',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}