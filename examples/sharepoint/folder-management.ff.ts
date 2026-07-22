@Flow("SharePoint Folder Management Workflow")
class SharePoint_Folder_Management_Workflow {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.ListRootFolder("List Root Folder Contents", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      folderPath: "/sites/yoursite/Shared Documents"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetFolderMetadataByPath("Get Folder Metadata By Path", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      path: "/sites/yoursite/Shared Documents/Projects"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.ListFolder("List Projects Folder", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      folderId: ctx.outputs('Get Folder Metadata By Path')?.['UniqueId']
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CopyFolder("Copy Folder to Archive", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      folderId: ctx.outputs('Get Folder Metadata By Path')?.['UniqueId'],
      destSiteUrl: "https://yourtenant.sharepoint.com/sites/yoursite",
      destFolderPath: "/sites/yoursite/Shared Documents/Archive/Projects"
    });
    /** @runAfter trigger */
    await ctx.compose("Summary", {
      message: "Folder management completed",
      rootFileCount: ctx.outputs('List Root Folder Contents')?.['files'].length,
      rootFolderCount: ctx.outputs('List Root Folder Contents')?.['folders'].length,
      projectsFileCount: ctx.outputs('List Projects Folder')?.['files'].length,
      projectsFolderCount: ctx.outputs('List Projects Folder')?.['folders'].length,
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
        runtimeUrl: '',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}