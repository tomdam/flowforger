@Flow("SharePoint Folder Management Workflow")
class SharePoint_Folder_Management_Workflow {
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
    let projectsFolderPath = "/sites/MySite/Shared Documents/Projects";
    let archiveFolderPath = "/sites/MySite/Shared Documents/Archive/Projects";

    await ctx.connectors.sharepoint.ListRootFolder("ListRootFolderContents", {
      dataset: ctx.variables("siteUrl"),
      folderPath: ctx.variables("folderPath")
    });
    await ctx.connectors.sharepoint.GetFolderMetadataByPath("GetFolderMetadataByPath", {
      dataset: ctx.variables("siteUrl"),
      path: ctx.variables("projectsFolderPath")
    });
    await ctx.connectors.sharepoint.ListFolder("ListProjectsFolder", {
      dataset: ctx.variables("siteUrl"),
      folderId: ctx.outputs('GetFolderMetadataByPath')?.['UniqueId']
    });
    await ctx.connectors.sharepoint.CopyFolder("CopyFolderToArchive", {
      dataset: ctx.variables("siteUrl"),
      folderId: ctx.outputs('GetFolderMetadataByPath')?.['UniqueId'],
      destSiteUrl: ctx.variables("siteUrl"),
      destFolderPath: ctx.variables("archiveFolderPath")
    });
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