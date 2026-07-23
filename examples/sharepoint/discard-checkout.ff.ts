@Flow("SharePoint Discard Check Out Example")
class SharePoint_Discard_Check_Out_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "File unique ID (GUID)" }
      }
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetFileMetadata("GetFileMetadata", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      fileId: ctx.triggerBody()?.['fileId']
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CheckOutFile("CheckOutFile", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      fileId: ctx.triggerBody()?.['fileId']
    });
    /** @runAfter trigger */
    await ctx.compose("SimulateWork", {
      message: "File is checked out, but we decide not to make changes"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.DiscardCheckOut("DiscardCheckOut", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      fileId: ctx.triggerBody()?.['fileId']
    });
    /** @runAfter trigger */
    await ctx.compose("Summary", {
      message: "Check out discarded, file unlocked without changes",
      fileName: ctx.outputs('GetFileMetadata')?.['Name']
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