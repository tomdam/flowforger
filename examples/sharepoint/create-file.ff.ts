@Flow("SharePoint Create File Example")
class SharePoint_Create_File_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.CreateFile("CreateTextFile", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      parameters: {
        folderPath: "/sites/yoursite/Shared Documents",
        name: "example.txt"
      },
      body: "Hello, this is a test file created by FlowForger!"
    });
    /** @runAfter trigger */
    await ctx.compose("ShowFileInfo", ctx.outputs('CreateTextFile'));
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