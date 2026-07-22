@Flow("SharePoint Copy File Example")
class SharePoint_Copy_File_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "The unique ID of the file to copy"
        },
        destFolder: { type: "string", description: "Destination folder path" }
      }
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.CopyFile("CopyFile", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      id: ctx.triggerBody()?.['fileId'],
      destSiteUrl: "https://yourtenant.sharepoint.com/sites/yoursite",
      destFolderPath: ctx.triggerBody()?.['destFolder']
    });
    /** @runAfter trigger */
    await ctx.compose("ShowResult", {
      success: ctx.outputs('CopyFile')?.['ok'],
      destination: ctx.outputs('CopyFile')?.['destUrl']
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