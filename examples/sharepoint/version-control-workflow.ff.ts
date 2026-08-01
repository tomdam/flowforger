@Flow("SharePoint Version Control Workflow")
class SharePoint_Version_Control_Workflow {
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

    await ctx.connectors.sharepoint.GetFilesPropertiesOnly("GetFilesNeedingUpdate", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.variables("libraryId"),
      filter: "FSObjType eq 0 and FileLeafRef eq 'report.docx'",
      top: 1
    });
    let fileId: string = ctx.first(ctx.outputs('GetFilesNeedingUpdate')?.['value'])?.['File']?.['UniqueId'];
    /** @action CheckIfFileFound */
    if ((ctx.outputs('GetFilesNeedingUpdate')?.['value'].length > 0)) {
      await ctx.connectors.sharepoint.CheckOutFile("CheckOutForEditing", {
        dataset: ctx.variables("siteUrl"),
        fileId: ctx.variables('fileId')
      });
      /** @action TryUpdateFile @type scope */
      {
        await ctx.connectors.sharepoint.UpdateFile("UpdateFileContent", {
          dataset: ctx.variables("siteUrl"),
          fileId: ctx.variables('fileId'),
          content: "Updated report content with new data"
        });
        await ctx.connectors.sharepoint.CheckInFile("CheckInWithMajorVersion", {
          dataset: ctx.variables("siteUrl"),
          fileId: ctx.variables('fileId'),
          comment: "Automated update - major version",
          checkInType: 1
        });
      }
      /** @action HandleFailure @type scope @runAfter TryUpdateFile: Failed */
      {
        await ctx.connectors.sharepoint.DiscardCheckOut("DiscardChangesOnError", {
          dataset: ctx.variables("siteUrl"),
          fileId: ctx.variables('fileId')
        });
      }
      /** @runAfter HandleFailure: Succeeded, Skipped */
      await ctx.connectors.sharepoint.GetItemChanges("GetVersionHistory", {
        dataset: ctx.variables("siteUrl"),
        listId: ctx.variables("libraryId"),
        itemId: ctx.first(ctx.outputs('GetFilesNeedingUpdate')?.['value'])?.['Id']
      });
    }
    await ctx.compose("Summary", {
      message: "Version control workflow completed",
      versionCount: ctx.outputs('GetVersionHistory')?.['value'].length
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