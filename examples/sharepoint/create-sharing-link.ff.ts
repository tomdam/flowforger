@Flow("SharePoint Create Sharing Link")
class SharePoint_Create_Sharing_Link {
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
    let fileId = "b8c2e5f7-3456-4a7b-9012-3c4d5e6f7a8b";

    await ctx.connectors.sharepoint.CreateSharingLink("CreateViewOnlySharingLink", {
      dataset: ctx.variables("siteUrl"),
      itemId: ctx.variables("fileId"),
      linkType: "view",
      scope: "anonymous"
    });
    await ctx.connectors.sharepoint.CreateSharingLink("CreateEditLinkForOrganization", {
      dataset: ctx.variables("siteUrl"),
      itemId: ctx.variables("fileId"),
      linkType: "edit",
      scope: "organization",
      expirationDateTime: "2025-12-31T23:59:59Z"
    });
    await ctx.connectors.sharepoint.CreateSharingLink("CreatePasswordProtectedLink", {
      dataset: ctx.variables("siteUrl"),
      itemId: ctx.variables("fileId"),
      linkType: "view",
      scope: "anonymous",
      password: "your-link-password",
      expirationDateTime: "2025-12-31T23:59:59Z"
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