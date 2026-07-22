@Flow("SharePoint Get File Properties Example")
class SharePoint_Get_File_Properties_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        libraryId: { type: "string", description: "The library GUID" },
        itemId: { type: "string", description: "The list item ID" }
      }
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetFileProperties("Get File Properties", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['libraryId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
    /** @runAfter trigger */
    await ctx.compose("Show Properties", {
      title: ctx.outputs('Get File Properties')?.['Title'],
      fileName: ctx.outputs('Get File Properties')?.['FileLeafRef'],
      created: ctx.outputs('Get File Properties')?.['Created'],
      modified: ctx.outputs('Get File Properties')?.['Modified'],
      author: ctx.outputs('Get File Properties')?.['Author']?.['Title']
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