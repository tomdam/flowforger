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
    // Configuration for this example - edit to point at your own tenant.
    // In a production flow, prefer a flow parameter bound to an environment
    // variable (ctx.parameters("...")), or values passed in via the trigger payload.
    let siteUrl = "https://contoso.sharepoint.com/sites/MySite";

    await ctx.connectors.sharepoint.GetAttachments("GetAttachments", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
    await ctx.compose("ShowAttachmentList", {
      attachmentCount: ctx.outputs('GetAttachments')?.['value'].length,
      attachments: ctx.outputs('GetAttachments')?.['value']
    });
    /** @action CheckIfHasAttachments */
    if ((ctx.outputs('GetAttachments')?.['value'].length > 0)) {
      await ctx.compose("FirstAttachment", ctx.first(ctx.outputs('GetAttachments')?.['value']));
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
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}