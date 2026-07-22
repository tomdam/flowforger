@Flow("SharePoint Get Files Properties Only Example")
class SharePoint_Get_Files_Properties_Only_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetFilesPropertiesOnly("GetAllFilesInFolder", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: "{LIBRARY-GUID}",
      folderPath: "/sites/yoursite/Shared Documents",
      top: 100
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetFilesPropertiesOnly("GetFilesWithFilter", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: "{LIBRARY-GUID}",
      filter: "FileLeafRef eq 'report.docx'",
      orderby: "Modified desc",
      top: 10
    });
    /** @runAfter trigger */
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
        runtimeUrl: '',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}