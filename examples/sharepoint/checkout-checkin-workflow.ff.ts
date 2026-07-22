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
    await ctx.connectors.sharepoint.GetFileMetadataByPath("GetFileMetadata", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      path: ctx.triggerBody()?.['filePath']
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CheckOutFile("CheckOutFile", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      fileId: ctx.outputs('GetFileMetadata')?.['UniqueId']
    });
    /** @runAfter trigger */
    await ctx.compose("FileCheckedOut", {
      message: "File is now locked for editing",
      fileId: ctx.outputs('GetFileMetadata')?.['UniqueId'],
      fileName: ctx.outputs('GetFileMetadata')?.['Name']
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.UpdateFile("UpdateFileContent", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      fileId: ctx.outputs('GetFileMetadata')?.['UniqueId'],
      content: "Updated content while file is checked out"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CheckInFile("CheckInFile", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      fileId: ctx.outputs('GetFileMetadata')?.['UniqueId'],
      comment: "Updated via FlowForger automation",
      checkInType: 1
    });
    /** @runAfter trigger */
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
        runtimeUrl: '',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}