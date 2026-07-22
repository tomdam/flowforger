@Flow("SharePoint Get Attachments Example")
class SharePoint_Get_Attachments_Example {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        listId: { type: "string", description: "The list GUID" },
        itemId: { type: "string", description: "The list item ID" }
      }
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetAttachments("Get Attachments", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
    /** @runAfter trigger */
    await ctx.compose("Show Attachment List", {
      attachmentCount: ctx.outputs('Get Attachments')?.['value'].length,
      attachments: ctx.outputs('Get Attachments')?.['value']
    });
    /** @action Check if Has Attachments @type if @runAfter trigger */
    if ((ctx.outputs('Get Attachments')?.['value'].length > 0)) {
      await ctx.compose("First Attachment", ctx.first(ctx.outputs('Get Attachments')?.['value']));
    }
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