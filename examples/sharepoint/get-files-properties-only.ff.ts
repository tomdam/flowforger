@Flow("SharePoint Get Files Properties Only Example")
class SharePoint_Get_Files_Properties_Only_Example {
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
    let folderPath = "/sites/MySite/Shared Documents";

    await ctx.connectors.sharepoint.GetFilesPropertiesOnly("GetAllFilesInFolder", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.variables("libraryId"),
      folderPath: ctx.variables("folderPath"),
      top: 100
    });
    await ctx.connectors.sharepoint.GetFilesPropertiesOnly("GetFilesWithFilter", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.variables("libraryId"),
      filter: "FileLeafRef eq 'report.docx'",
      orderby: "Modified desc",
      top: 10
    });
    await ctx.compose("ShowFileCount", {
      allFilesCount: ctx.outputs('GetAllFilesInFolder')?.['value'].length,
      filteredCount: ctx.outputs('GetFilesWithFilter')?.['value'].length
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