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
    /** @action InitializeSiteUrl */
    let siteUrl: string = ctx.triggerBody().siteUrl;
    /** @action InitializeLibraryId @runAfter first */
    let libraryId: string = ctx.triggerBody().libraryId;
    /** @action InitializeItemId @runAfter first */
    let itemId: string = ctx.triggerBody().itemId;
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetContentApprovalStatus("GetCurrentApprovalStatus", {
      dataset: ctx.variables('siteUrl'),
      table: ctx.variables('libraryId'),
      itemId: ctx.variables('itemId')
    });
    /** @runAfter trigger */
    await ctx.compose("LogCurrentStatus", {
      message: "Current approval status retrieved",
      itemId: ctx.body('GetCurrentApprovalStatus').Id,
      title: ctx.body('GetCurrentApprovalStatus').Title,
      currentStatus: ctx.body('GetCurrentApprovalStatus').approvalStatusText,
      moderationComments: ctx.body('GetCurrentApprovalStatus')._ModerationComments
    });
    /** @action Check action type @type if @runAfter trigger */
    if ((ctx.triggerBody().action === 'Approved')) {
      await ctx.connectors.sharepoint.SetContentApprovalStatus("ApproveItem", {
        dataset: ctx.variables('siteUrl'),
        table: ctx.variables('libraryId'),
        itemId: ctx.variables('itemId'),
        approvalStatus: "Approved",
        comments: (ctx.triggerBody().comments ?? 'Approved via automated workflow')
      });
      /** @runAfter first */
      await ctx.compose("ApprovalSuccess", {
        status: "Approved",
        message: "Item has been approved successfully",
        itemId: ctx.variables('itemId'),
        comments: ctx.triggerBody().comments
      });
    } else {
      await ctx.connectors.sharepoint.SetContentApprovalStatus("RejectItem", {
        dataset: ctx.variables('siteUrl'),
        table: ctx.variables('libraryId'),
        itemId: ctx.variables('itemId'),
        approvalStatus: "Rejected",
        comments: (ctx.triggerBody().comments ?? 'Rejected via automated workflow')
      });
      /** @runAfter first */
      await ctx.compose("RejectionSuccess", {
        status: "Rejected",
        message: "Item has been rejected",
        itemId: ctx.variables('itemId'),
        comments: ctx.triggerBody().comments
      });
    }
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetContentApprovalStatus("VerifyFinalStatus", {
      dataset: ctx.variables('siteUrl'),
      table: ctx.variables('libraryId'),
      itemId: ctx.variables('itemId')
    });
    /** @runAfter trigger */
    await ctx.compose("WorkflowSummary", {
      workflowCompleted: ctx.utcNow(),
      itemId: ctx.variables('itemId'),
      finalStatus: ctx.body('VerifyFinalStatus').approvalStatusText,
      previousStatus: ctx.body('GetCurrentApprovalStatus').approvalStatusText,
      actionTaken: ctx.triggerBody().action,
      comments: ctx.body('VerifyFinalStatus')._ModerationComments
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