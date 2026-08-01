@Flow("SharePoint File Properties Workflow")
class SharePoint_File_Properties_Workflow {
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
    let libraryId = "aaaaaaaa-1111-2222-3333-444444444444";
    let folderPath = "/sites/MySite/Shared Documents/Reports";

    await ctx.connectors.sharepoint.GetFilesPropertiesOnly("GetFilesInReportsFolder", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.variables("libraryId"),
      folderPath: ctx.variables("folderPath"),
      filter: "FSObjType eq 0",
      orderby: "Modified desc",
      top: 50
    });
    /** @action ForEachFile */
    for (const item of ctx.outputs('GetFilesInReportsFolder')?.['value']) {
      await ctx.connectors.sharepoint.GetFileProperties("GetFileProperties", {
        dataset: ctx.variables("siteUrl"),
        listId: ctx.variables("libraryId"),
        itemId: ctx.items('ForEachFile')?.['Id']
      });
      /** @action CheckIfMissingTitle */
      if ((ctx.empty(ctx.outputs('GetFileProperties')?.['Title']) || (ctx.outputs('GetFileProperties')?.['Title'] === ''))) {
        await ctx.connectors.sharepoint.UpdateFileProperties("UpdateTitle", {
          dataset: ctx.variables("siteUrl"),
          listId: ctx.variables("libraryId"),
          itemId: ctx.items('ForEachFile')?.['Id'],
          item: { Title: ctx.items('ForEachFile')?.['FileLeafRef'] }
        });
      }
      await ctx.connectors.sharepoint.GetItemChanges("GetChangeHistory", {
        dataset: ctx.variables("siteUrl"),
        listId: ctx.variables("libraryId"),
        itemId: ctx.items('ForEachFile')?.['Id'],
        since: ctx.addDays(ctx.utcNow(), -30)
      });
    }
    await ctx.compose("Summary", {
      message: "File properties workflow completed",
      filesProcessed: ctx.outputs('GetFilesInReportsFolder')?.['value'].length
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