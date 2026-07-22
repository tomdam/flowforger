@Flow("SharePoint Get Approval Status")
class SharePoint_Get_Approval_Status {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetContentApprovalStatus("GetItemApprovalStatus", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      table: "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}",
      itemId: "5"
    });
    /** @runAfter trigger */
    await ctx.compose("DisplayApprovalInfo", {
      itemId: ctx.body('GetItemApprovalStatus').Id,
      title: ctx.body('GetItemApprovalStatus').Title,
      approvalStatus: ctx.body('GetItemApprovalStatus').approvalStatusText,
      statusCode: ctx.body('GetItemApprovalStatus')._ModerationStatus,
      comments: ctx.body('GetItemApprovalStatus')._ModerationComments,
      lastModified: ctx.body('GetItemApprovalStatus').Modified,
      modifiedBy: ctx.body('GetItemApprovalStatus').Editor.Title
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