@Flow("SharePoint Version Control Workflow")
class SharePoint_Version_Control_Workflow {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetFilesPropertiesOnly("GetFilesNeedingUpdate", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: "{LIBRARY-GUID}",
      filter: "FSObjType eq 0 and FileLeafRef eq 'report.docx'",
      top: 1
    });
    /** @action InitializeFileId */
    let fileId: string = ctx.first(ctx.outputs('GetFilesNeedingUpdate')?.['value'])?.['File']?.['UniqueId'];
    /** @action CheckIfFileFound @type if */
    if ((ctx.outputs('GetFilesNeedingUpdate')?.['value'].length > 0)) {
      /** @runAfter first */
      await ctx.connectors.sharepoint.CheckOutFile("CheckOutForEditing", {
        dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
        fileId: ctx.variables('fileId')
      });
      /** @action TryUpdateFile @type scope @runAfter first */
      {
        await ctx.connectors.sharepoint.UpdateFile("UpdateFileContent", {
          dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
          fileId: ctx.variables('fileId'),
          content: "Updated report content with new data"
        });
        /** @runAfter first */
        await ctx.connectors.sharepoint.CheckInFile("CheckInWithMajorVersion", {
          dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
          fileId: ctx.variables('fileId'),
          comment: "Automated update - major version",
          checkInType: 1
        });
      }
      /** @action HandleFailure @type scope @runAfter TryUpdateFile: Failed */
      {
        await ctx.connectors.sharepoint.DiscardCheckOut("DiscardChangesOnError", {
          dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
          fileId: ctx.variables('fileId')
        });
      }
      /** @runAfter first */
      await ctx.connectors.sharepoint.GetItemChanges("GetVersionHistory", {
        dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
        listId: "{LIBRARY-GUID}",
        itemId: ctx.first(ctx.outputs('GetFilesNeedingUpdate')?.['value'])?.['Id']
      });
    }
    /** @runAfter trigger */
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