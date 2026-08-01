@Flow("SharePoint File Operations Example")
class SharePoint_File_Operations_Example {
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
    let folderPath = "/sites/MySite/Shared Documents";
    let filePath = "/sites/MySite/Shared Documents/test-file.txt";
    let archiveFolderPath = "/sites/MySite/Shared Documents/Archive";

    await ctx.connectors.sharepoint.CreateFile("CreateFile", {
      dataset: ctx.variables("siteUrl"),
      folderPath: ctx.variables("folderPath"),
      name: "test-file.txt",
      body: "Initial content"
    });
    await ctx.connectors.sharepoint.GetFileMetadataByPath("GetFileMetadata", {
      dataset: ctx.variables("siteUrl"),
      path: ctx.variables("filePath")
    });
    await ctx.connectors.sharepoint.UpdateFile("UpdateFileContent", {
      dataset: ctx.variables("siteUrl"),
      id: ctx.outputs('GetFileMetadata')?.['UniqueId'],
      body: "Updated content - modified by FlowForger"
    });
    await ctx.connectors.sharepoint.GetFileContent("GetUpdatedContent", {
      dataset: ctx.variables("siteUrl"),
      id: ctx.outputs('GetFileMetadata')?.['UniqueId']
    });
    await ctx.connectors.sharepoint.CopyFile("CopyToArchive", {
      dataset: ctx.variables("siteUrl"),
      id: ctx.outputs('GetFileMetadata')?.['UniqueId'],
      destSiteUrl: ctx.variables("siteUrl"),
      destFolderPath: ctx.variables("archiveFolderPath")
    });
    await ctx.connectors.sharepoint.DeleteFile("DeleteOriginal", {
      dataset: ctx.variables("siteUrl"),
      id: ctx.outputs('GetFileMetadata')?.['UniqueId']
    });
    await ctx.compose("Summary", {
      message: "File operations completed successfully",
      operations: [
        "Created file",
        "Retrieved metadata",
        "Updated content",
        "Retrieved updated content",
        "Copied to archive",
        "Deleted original"
      ]
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