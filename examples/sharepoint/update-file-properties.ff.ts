@Flow("SharePoint Update File Properties Example")
class SharePoint_Update_File_Properties_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetFileMetadataByPath("GetFileMetadata", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      path: "/sites/yoursite/Shared Documents/report.docx"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.UpdateFileProperties("UpdateFileProperties", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.outputs('GetFileMetadata')?.['ListId'],
      itemId: ctx.outputs('GetFileMetadata')?.['ListItemAllFields']?.['Id'],
      fields: { Title: "Updated Report Title", CustomColumn: "New Value" }
    });
    /** @runAfter trigger */
    await ctx.compose("ShowResult", {
      success: ctx.outputs('UpdateFileProperties')?.['ok'],
      message: "File properties updated successfully"
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