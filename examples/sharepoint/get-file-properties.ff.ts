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
    await ctx.connectors.sharepoint.GetFileProperties("GetFileProperties", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['libraryId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
    /** @runAfter trigger */
    await ctx.compose("ShowProperties", {
      title: ctx.outputs('GetFileProperties')?.['Title'],
      fileName: ctx.outputs('GetFileProperties')?.['FileLeafRef'],
      created: ctx.outputs('GetFileProperties')?.['Created'],
      modified: ctx.outputs('GetFileProperties')?.['Modified'],
      author: ctx.outputs('GetFileProperties')?.['Author']?.['Title']
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