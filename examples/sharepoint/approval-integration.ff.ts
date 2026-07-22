@Flow("SharePoint Approval Integration with Power Automate Approvals")
class SharePoint_Approval_Integration_with_Power_Automate_Approvals {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        siteUrl: { type: "string" },
        libraryId: { type: "string" },
        itemId: { type: "string" },
        approverEmail: { type: "string" }
      },
      required: ["siteUrl", "libraryId", "itemId", "approverEmail"]
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetContentApprovalStatus("Get document details", {
      dataset: ctx.triggerBody().siteUrl,
      table: ctx.triggerBody().libraryId,
      itemId: ctx.triggerBody().itemId
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.SetContentApprovalStatus("Set to pending approval", {
      dataset: ctx.triggerBody().siteUrl,
      table: ctx.triggerBody().libraryId,
      itemId: ctx.triggerBody().itemId,
      approvalStatus: "Pending",
      comments: "Pending approval from designated approver"
    });
    /** @runAfter trigger */
    await ctx.connectorWebhook("Start approval request", "approvals", "StartAndWaitForAnApproval", {
      approvalType: "Basic",
      WebhookApprovalCreationInput: {
        title: `Approval Required: ${ctx.body('Get document details').Title}`,
        assignedTo: ctx.triggerBody().approverEmail,
        details: `Please review and approve the document: ${ctx.body('Get document details').Title}

Current Status: ${ctx.body('Get document details').approvalStatusText}
Last Modified: ${ctx.body('Get document details').Modified}`,
        enableNotifications: true,
        enableReassignment: true
      }
    });
    /** @action Check approval response @type if @runAfter trigger */
    if ((ctx.body('Start approval request').outcome === 'Approve')) {
      await ctx.connectors.sharepoint.SetContentApprovalStatus("Approve in SharePoint", {
        dataset: ctx.triggerBody().siteUrl,
        table: ctx.triggerBody().libraryId,
        itemId: ctx.triggerBody().itemId,
        approvalStatus: "Approved",
        comments: `Approved by ${ctx.body('Start approval request').responses[0].approver.displayName} - ${ctx.body('Start approval request').responses[0].comments}`
      });
    } else {
      await ctx.connectors.sharepoint.SetContentApprovalStatus("Reject in SharePoint", {
        dataset: ctx.triggerBody().siteUrl,
        table: ctx.triggerBody().libraryId,
        itemId: ctx.triggerBody().itemId,
        approvalStatus: "Rejected",
        comments: `Rejected by ${ctx.body('Start approval request').responses[0].approver.displayName} - ${ctx.body('Start approval request').responses[0].comments}`
      });
    }
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetContentApprovalStatus("Get final status", {
      dataset: ctx.triggerBody().siteUrl,
      table: ctx.triggerBody().libraryId,
      itemId: ctx.triggerBody().itemId
    });
    /** @runAfter trigger */
    await ctx.compose("Summary", {
      approvalCompleted: ctx.utcNow(),
      document: ctx.body('Get document details').Title,
      approver: ctx.body('Start approval request').responses[0].approver.displayName,
      outcome: ctx.body('Start approval request').outcome,
      comments: ctx.body('Start approval request').responses[0].comments,
      finalStatus: ctx.body('Get final status').approvalStatusText,
      moderationComments: ctx.body('Get final status')._ModerationComments
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