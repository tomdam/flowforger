@Flow("SharePoint Set Approval Status")
class SharePoint_Set_Approval_Status {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.SetContentApprovalStatus("Approve document", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      table: "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}",
      itemId: "5",
      approvalStatus: "Approved",
      comments: "Document meets all quality standards and is approved for publication"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.SetContentApprovalStatus("Reject document with comments", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      table: "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}",
      itemId: "6",
      approvalStatus: "Rejected",
      comments: "Document requires additional review. Please address formatting issues and resubmit."
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.SetContentApprovalStatus("Set to pending approval", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      table: "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}",
      itemId: "7",
      approvalStatus: "Pending",
      comments: "Awaiting review from management team"
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