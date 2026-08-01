@Flow("SharePoint Attachment Workflow")
class SharePoint_Attachment_Workflow {
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

    await ctx.connectors.sharepoint.AddAttachment("AddFirstAttachment", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId'],
      fileName: "document1.txt",
      content: "This is the first attachment content"
    });
    await ctx.connectors.sharepoint.AddAttachment("AddSecondAttachment", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId'],
      fileName: "document2.txt",
      content: "This is the second attachment content"
    });
    await ctx.connectors.sharepoint.GetAttachments("GetAllAttachments", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
    /** @action ForEachAttachment */
    for (const item of ctx.outputs('GetAllAttachments')?.['value']) {
      await ctx.connectors.sharepoint.GetAttachmentContent("GetAttachmentContent", {
        dataset: ctx.variables("siteUrl"),
        listId: ctx.triggerBody()?.['listId'],
        itemId: ctx.triggerBody()?.['itemId'],
        attachmentId: ctx.items('ForEachAttachment')?.['FileName']
      });
      await ctx.compose("AttachmentInfo", {
        fileName: ctx.items('ForEachAttachment')?.['FileName'],
        contentType: ctx.outputs('GetAttachmentContent')?.['$contentType'],
        contentSize: ctx.outputs('GetAttachmentContent')?.['$content'].length
      });
    }
    await ctx.connectors.sharepoint.DeleteAttachment("DeleteFirstAttachment", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId'],
      attachmentId: "document1.txt"
    });
    await ctx.connectors.sharepoint.GetAttachments("GetRemainingAttachments", {
      dataset: ctx.variables("siteUrl"),
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
    await ctx.compose("Summary", {
      message: "Attachment workflow completed",
      initialAttachments: 2,
      processedAttachments: ctx.outputs('GetAllAttachments')?.['value'].length,
      remainingAttachments: ctx.outputs('GetRemainingAttachments')?.['value'].length
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