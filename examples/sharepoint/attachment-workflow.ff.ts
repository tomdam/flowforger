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
    await ctx.connectors.sharepoint.AddAttachment("Add First Attachment", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId'],
      fileName: "document1.txt",
      content: "This is the first attachment content"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.AddAttachment("Add Second Attachment", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId'],
      fileName: "document2.txt",
      content: "This is the second attachment content"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetAttachments("Get All Attachments", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
    /** @action For Each Attachment @type foreach @runAfter trigger */
    for (const item of ctx.outputs('Get All Attachments')?.['value']) {
      await ctx.connectors.sharepoint.GetAttachmentContent("Get Attachment Content", {
        dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
        listId: ctx.triggerBody()?.['listId'],
        itemId: ctx.triggerBody()?.['itemId'],
        attachmentId: ctx.items('For Each Attachment')?.['FileName']
      });
      /** @runAfter first */
      await ctx.compose("Attachment Info", {
        fileName: ctx.items('For Each Attachment')?.['FileName'],
        contentType: ctx.outputs('Get Attachment Content')?.['$contentType'],
        contentSize: ctx.outputs('Get Attachment Content')?.['$content'].length
      });
    }
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.DeleteAttachment("Delete First Attachment", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId'],
      attachmentId: "document1.txt"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetAttachments("Get Remaining Attachments", {
      dataset: "https://yourtenant.sharepoint.com/sites/yoursite",
      listId: ctx.triggerBody()?.['listId'],
      itemId: ctx.triggerBody()?.['itemId']
    });
    /** @runAfter trigger */
    await ctx.compose("Summary", {
      message: "Attachment workflow completed",
      initialAttachments: 2,
      processedAttachments: ctx.outputs('Get All Attachments')?.['value'].length,
      remainingAttachments: ctx.outputs('Get Remaining Attachments')?.['value'].length
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