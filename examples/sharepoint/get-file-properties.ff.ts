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
    // Configuration for this example - edit to point at your own tenant.
    // In a production flow, prefer a flow parameter bound to an environment
    // variable (ctx.parameters("...")), or values passed in via the trigger payload.
    let siteUrl = "https://contoso.sharepoint.com/sites/MySite";

    await ctx.connectors.sharepoint.GetFileProperties("GetFileProperties", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.triggerBody()?.['libraryId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
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
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}