@Flow("SharePoint File Properties Workflow")
class SharePoint_File_Properties_Workflow {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetFilesPropertiesOnly("Get Files in Reports Folder", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: "{LIBRARY-GUID}",
      folderPath: "/sites/yoursite/Shared Documents/Reports",
      filter: "FSObjType eq 0",
      orderby: "Modified desc",
      top: 50
    });
    /** @action For Each File @type foreach @runAfter trigger */
    for (const item of ctx.outputs('Get Files in Reports Folder')?.['value']) {
      await ctx.connectors.sharepoint.GetFileProperties("Get File Properties", {
        dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
        listId: "{LIBRARY-GUID}",
        itemId: ctx.items('For Each File')?.['Id']
      });
      /** @action Check if Missing Title @type if @runAfter first */
      if ((ctx.empty(ctx.outputs('Get File Properties')?.['Title']) || (ctx.outputs('Get File Properties')?.['Title'] === ''))) {
        await ctx.connectors.sharepoint.UpdateFileProperties("Update Title", {
          dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
          listId: "{LIBRARY-GUID}",
          itemId: ctx.items('For Each File')?.['Id'],
          fields: { Title: ctx.items('For Each File')?.['FileLeafRef'] }
        });
      }
      /** @runAfter first */
      await ctx.connectors.sharepoint.GetItemChanges("Get Change History", {
        dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
        listId: "{LIBRARY-GUID}",
        itemId: ctx.items('For Each File')?.['Id'],
        since: ctx.addDays(ctx.utcNow(), -30)
      });
    }
    /** @runAfter trigger */
    await ctx.compose("Summary", {
      message: "File properties workflow completed",
      filesProcessed: ctx.outputs('Get Files in Reports Folder')?.['value'].length
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