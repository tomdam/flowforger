@Flow("SharePoint Get File Content Example")
class SharePoint_Get_File_Content_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "The unique ID of the file to retrieve"
        }
      }
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetFileContent("GetFileContent", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      id: ctx.triggerBody()?.['fileId']
    });
    /** @runAfter trigger */
    await ctx.compose("ShowContentInfo", {
      contentType: ctx.outputs('GetFileContent')?.['$contentType'],
      contentSize: ctx.outputs('GetFileContent')?.['$content'].length
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