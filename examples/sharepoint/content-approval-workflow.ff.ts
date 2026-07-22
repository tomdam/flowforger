@Flow("SharePoint Content Approval Workflow")
class SharePoint_Content_Approval_Workflow {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        siteUrl: { type: "string", description: "SharePoint site URL" },
        libraryId: {
          type: "string",
          description: "Document library ID (with content approval enabled)"
        },
        itemId: { type: "string", description: "Item ID to approve/reject" },
        action: {
          type: "string",
          description: "Approval action: Approved or Rejected"
        },
        comments: { type: "string", description: "Approval comments" }
      },
      required: ["siteUrl", "libraryId", "itemId", "action"]
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize site URL */
    let siteUrl: string = ctx.triggerBody().siteUrl;
    /** @action Initialize library ID @runAfter first */
    let libraryId: string = ctx.triggerBody().libraryId;
    /** @action Initialize item ID @runAfter first */
    let itemId: string = ctx.triggerBody().itemId;
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetContentApprovalStatus("Get current approval status", {
      dataset: ctx.variables('siteUrl'),
      table: ctx.variables('libraryId'),
      itemId: ctx.variables('itemId')
    });
    /** @runAfter trigger */
    await ctx.compose("Log current status", {
      message: "Current approval status retrieved",
      itemId: ctx.body('Get current approval status').Id,
      title: ctx.body('Get current approval status').Title,
      currentStatus: ctx.body('Get current approval status').approvalStatusText,
      moderationComments: ctx.body('Get current approval status')._ModerationComments
    });
    /** @action Check action type @type if @runAfter trigger */
    if ((ctx.triggerBody().action === 'Approved')) {
      await ctx.connectors.sharepoint.SetContentApprovalStatus("Approve item", {
        dataset: ctx.variables('siteUrl'),
        table: ctx.variables('libraryId'),
        itemId: ctx.variables('itemId'),
        approvalStatus: "Approved",
        comments: (ctx.triggerBody().comments ?? 'Approved via automated workflow')
      });
      /** @runAfter first */
      await ctx.compose("Approval success", {
        status: "Approved",
        message: "Item has been approved successfully",
        itemId: ctx.variables('itemId'),
        comments: ctx.triggerBody().comments
      });
    } else {
      await ctx.connectors.sharepoint.SetContentApprovalStatus("Reject item", {
        dataset: ctx.variables('siteUrl'),
        table: ctx.variables('libraryId'),
        itemId: ctx.variables('itemId'),
        approvalStatus: "Rejected",
        comments: (ctx.triggerBody().comments ?? 'Rejected via automated workflow')
      });
      /** @runAfter first */
      await ctx.compose("Rejection success", {
        status: "Rejected",
        message: "Item has been rejected",
        itemId: ctx.variables('itemId'),
        comments: ctx.triggerBody().comments
      });
    }
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetContentApprovalStatus("Verify final status", {
      dataset: ctx.variables('siteUrl'),
      table: ctx.variables('libraryId'),
      itemId: ctx.variables('itemId')
    });
    /** @runAfter trigger */
    await ctx.compose("Workflow summary", {
      workflowCompleted: ctx.utcNow(),
      itemId: ctx.variables('itemId'),
      finalStatus: ctx.body('Verify final status').approvalStatusText,
      previousStatus: ctx.body('Get current approval status').approvalStatusText,
      actionTaken: ctx.triggerBody().action,
      comments: ctx.body('Verify final status')._ModerationComments
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