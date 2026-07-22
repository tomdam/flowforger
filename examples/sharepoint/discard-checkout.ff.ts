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
    await ctx.connectors.sharepoint.GetFileMetadata("Get File Metadata", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      fileId: ctx.triggerBody()?.['fileId']
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CheckOutFile("Check Out File", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      fileId: ctx.triggerBody()?.['fileId']
    });
    /** @runAfter trigger */
    await ctx.compose("Simulate Work", {
      message: "File is checked out, but we decide not to make changes"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.DiscardCheckOut("Discard Check Out", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      fileId: ctx.triggerBody()?.['fileId']
    });
    /** @runAfter trigger */
    await ctx.compose("Summary", {
      message: "Check out discarded, file unlocked without changes",
      fileName: ctx.outputs('Get File Metadata')?.['Name']
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