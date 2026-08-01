@Flow("SharePoint Update File Properties Example")
class SharePoint_Update_File_Properties_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    // Configuration for this example - edit to point at your own tenant.
    // In a production flow, prefer a flow parameter bound to an environment
    // variable (ctx.parameters("...")), or values passed in via the trigger payload.
    let siteUrl = "https://contoso.sharepoint.com/sites/MySite";
    let filePath = "/sites/MySite/Shared Documents/report.docx";

    await ctx.connectors.sharepoint.GetFileMetadataByPath("GetFileMetadata", {
      dataset: ctx.variables("siteUrl"),
      path: ctx.variables("filePath")
    });
    await ctx.connectors.sharepoint.UpdateFileProperties("UpdateFileProperties", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.outputs('GetFileMetadata')?.['ListId'],
      itemId: ctx.outputs('GetFileMetadata')?.['ListItemAllFields']?.['Id'],
      item: { Title: "Updated Report Title", CustomColumn: "New Value" }
    });
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
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}