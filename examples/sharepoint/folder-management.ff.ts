@Flow("SharePoint Folder Management Workflow")
class SharePoint_Folder_Management_Workflow {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.ListRootFolder("ListRootFolderContents", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      folderPath: "/sites/yoursite/Shared Documents"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetFolderMetadataByPath("GetFolderMetadataByPath", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      path: "/sites/yoursite/Shared Documents/Projects"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.ListFolder("ListProjectsFolder", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      folderId: ctx.outputs('GetFolderMetadataByPath')?.['UniqueId']
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CopyFolder("CopyFolderToArchive", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      folderId: ctx.outputs('GetFolderMetadataByPath')?.['UniqueId'],
      destSiteUrl: "https://yourtenant.sharepoint.com/sites/yoursite",
      destFolderPath: "/sites/yoursite/Shared Documents/Archive/Projects"
    });
    /** @runAfter trigger */
    await ctx.compose("Summary", {
      message: "Folder management completed",
      rootFileCount: ctx.outputs('ListRootFolderContents')?.['files'].length,
      rootFolderCount: ctx.outputs('ListRootFolderContents')?.['folders'].length,
      projectsFileCount: ctx.outputs('ListProjectsFolder')?.['files'].length,
      projectsFolderCount: ctx.outputs('ListProjectsFolder')?.['folders'].length,
      archived: true
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