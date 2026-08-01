@Flow("SharePoint Check Out/Check In Workflow")
class SharePoint_Check_Out_Check_In_Workflow {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Server-relative file path" }
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

    await ctx.connectors.sharepoint.GetFileMetadataByPath("GetFileMetadata", {
      dataset: ctx.variables("siteUrl"),
      path: ctx.triggerBody()?.['filePath']
    });
    await ctx.connectors.sharepoint.CheckOutFile("CheckOutFile", {
      dataset: ctx.variables("siteUrl"),
      fileId: ctx.outputs('GetFileMetadata')?.['UniqueId']
    });
    await ctx.compose("FileCheckedOut", {
      message: "File is now locked for editing",
      fileId: ctx.outputs('GetFileMetadata')?.['UniqueId'],
      fileName: ctx.outputs('GetFileMetadata')?.['Name']
    });
    await ctx.connectors.sharepoint.UpdateFile("UpdateFileContent", {
      dataset: ctx.variables("siteUrl"),
      fileId: ctx.outputs('GetFileMetadata')?.['UniqueId'],
      content: "Updated content while file is checked out"
    });
    await ctx.connectors.sharepoint.CheckInFile("CheckInFile", {
      dataset: ctx.variables("siteUrl"),
      fileId: ctx.outputs('GetFileMetadata')?.['UniqueId'],
      comment: "Updated via FlowForger automation",
      checkInType: 1
    });
    await ctx.compose("Summary", {
      message: "File successfully updated and checked in",
      fileName: ctx.outputs('GetFileMetadata')?.['Name'],
      checkInComment: "Updated via FlowForger automation"
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