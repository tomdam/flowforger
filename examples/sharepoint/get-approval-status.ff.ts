@Flow("SharePoint Get Approval Status")
class SharePoint_Get_Approval_Status {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetContentApprovalStatus("Get item approval status", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      table: "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}",
      itemId: "5"
    });
    /** @runAfter trigger */
    await ctx.compose("Display approval info", {
      itemId: ctx.body('Get item approval status').Id,
      title: ctx.body('Get item approval status').Title,
      approvalStatus: ctx.body('Get item approval status').approvalStatusText,
      statusCode: ctx.body('Get item approval status')._ModerationStatus,
      comments: ctx.body('Get item approval status')._ModerationComments,
      lastModified: ctx.body('Get item approval status').Modified,
      modifiedBy: ctx.body('Get item approval status').Editor.Title
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