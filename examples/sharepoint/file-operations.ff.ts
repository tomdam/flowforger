@Flow("SharePoint File Operations Example")
class SharePoint_File_Operations_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.CreateFile("CreateFile", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      parameters: {
        folderPath: "/sites/yoursite/Shared Documents",
        name: "test-file.txt"
      },
      body: "Initial content"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetFileMetadataByPath("GetFileMetadata", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      path: "/sites/yoursite/Shared Documents/test-file.txt"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.UpdateFile("UpdateFileContent", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      id: ctx.outputs('GetFileMetadata')?.['UniqueId'],
      body: "Updated content - modified by FlowForger"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetFileContent("GetUpdatedContent", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      id: ctx.outputs('GetFileMetadata')?.['UniqueId']
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CopyFile("CopyToArchive", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      id: ctx.outputs('GetFileMetadata')?.['UniqueId'],
      destSiteUrl: "https://yourtenant.sharepoint.com/sites/yoursite",
      destFolderPath: "/sites/yoursite/Shared Documents/Archive"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.DeleteFile("DeleteOriginal", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      id: ctx.outputs('GetFileMetadata')?.['UniqueId']
    });
    /** @runAfter trigger */
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
        runtimeUrl: '',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}