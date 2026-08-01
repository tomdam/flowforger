@Flow("SharePoint Get Approval Status")
class SharePoint_Get_Approval_Status {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    // Configuration for this example - edit to point at your own tenant.
    // In a production flow, prefer a flow parameter bound to an environment
    // variable (ctx.parameters("...")), or values passed in via the trigger payload.
    let siteUrl = "https://contoso.sharepoint.com/sites/MySite";
    let libraryId = "aaaaaaaa-1111-2222-3333-444444444444";
    let itemId = "5";

    await ctx.connectors.sharepoint.GetContentApprovalStatus("GetItemApprovalStatus", {
      dataset: ctx.variables("siteUrl"),
      table: ctx.variables("libraryId"),
      itemId: ctx.variables("itemId")
    });
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
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}