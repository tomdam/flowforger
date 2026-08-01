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
    // Configuration for this example - edit to point at your own tenant.
    // In a production flow, prefer a flow parameter bound to an environment
    // variable (ctx.parameters("...")), or values passed in via the trigger payload.
    let siteUrl = "https://contoso.sharepoint.com/sites/MySite";

    await ctx.connectors.sharepoint.CopyFile("CopyFile", {
      dataset: ctx.variables("siteUrl"),
      id: ctx.triggerBody()?.['fileId'],
      destSiteUrl: ctx.variables("siteUrl"),
      destFolderPath: ctx.triggerBody()?.['destFolder']
    });
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
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}