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
    await ctx.connectors.sharepoint.AddAttachment("AddFirstAttachment", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId'],
      fileName: "document1.txt",
      content: "This is the first attachment content"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.AddAttachment("AddSecondAttachment", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId'],
      fileName: "document2.txt",
      content: "This is the second attachment content"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetAttachments("GetAllAttachments", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
    /** @action ForEachAttachment @type foreach @runAfter trigger */
    for (const item of ctx.outputs('GetAllAttachments')?.['value']) {
      await ctx.connectors.sharepoint.GetAttachmentContent("GetAttachmentContent", {
        dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
        listId: ctx.triggerBody()?.['listId'],
        itemId: ctx.triggerBody()?.['itemId'],
        attachmentId: ctx.items('ForEachAttachment')?.['FileName']
      });
      /** @runAfter first */
      await ctx.compose("AttachmentInfo", {
        fileName: ctx.items('ForEachAttachment')?.['FileName'],
        contentType: ctx.outputs('GetAttachmentContent')?.['$contentType'],
        contentSize: ctx.outputs('GetAttachmentContent')?.['$content'].length
      });
    }
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.DeleteAttachment("DeleteFirstAttachment", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId'],
      attachmentId: "document1.txt"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetAttachments("GetRemainingAttachments", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
    /** @runAfter trigger */
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