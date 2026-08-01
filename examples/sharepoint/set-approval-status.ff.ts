@Flow("SharePoint Set Approval Status")
class SharePoint_Set_Approval_Status {
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

    await ctx.connectors.sharepoint.SetContentApprovalStatus("ApproveDocument", {
      dataset: ctx.variables("siteUrl"),
      table: ctx.variables("libraryId"),
      itemId: "5",
      approvalStatus: "Approved",
      comments: "Document meets all quality standards and is approved for publication"
    });
    await ctx.connectors.sharepoint.SetContentApprovalStatus("RejectDocumentWithComments", {
      dataset: ctx.variables("siteUrl"),
      table: ctx.variables("libraryId"),
      itemId: "6",
      approvalStatus: "Rejected",
      comments: "Document requires additional review. Please address formatting issues and resubmit."
    });
    await ctx.connectors.sharepoint.SetContentApprovalStatus("SetToPendingApproval", {
      dataset: ctx.variables("siteUrl"),
      table: ctx.variables("libraryId"),
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
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}