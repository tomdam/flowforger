@Flow("SharePoint Add Attachment Example")
class SharePoint_Add_Attachment_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        listId: { type: "string", description: "The list GUID" },
        itemId: { type: "string", description: "The list item ID" },
        fileName: { type: "string", description: "Attachment filename" },
        fileContent: {
          type: "string",
          description: "File content (base64 or text)"
        }
      }
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.AddAttachment("AddAttachment", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId'],
      fileName: ctx.triggerBody()?.['fileName'],
      content: ctx.triggerBody()?.['fileContent']
    });
    /** @runAfter trigger */
    await ctx.compose("ShowResult", {
      message: "Attachment added successfully",
      fileName: ctx.outputs('AddAttachment')?.['FileName'],
      serverRelativeUrl: ctx.outputs('AddAttachment')?.['ServerRelativeUrl']
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