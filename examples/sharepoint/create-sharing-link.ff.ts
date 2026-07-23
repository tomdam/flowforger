@Flow("SharePoint Create Sharing Link")
class SharePoint_Create_Sharing_Link {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.CreateSharingLink("CreateViewOnlySharingLink", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      itemId: "b8c2e5f7-3456-4a7b-9012-3c4d5e6f7a8b",
      linkType: "view",
      scope: "anonymous"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CreateSharingLink("CreateEditLinkForOrganization", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      itemId: "b8c2e5f7-3456-4a7b-9012-3c4d5e6f7a8b",
      linkType: "edit",
      scope: "organization",
      expirationDateTime: "2025-12-31T23:59:59Z"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CreateSharingLink("CreatePasswordProtectedLink", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      itemId: "b8c2e5f7-3456-4a7b-9012-3c4d5e6f7a8b",
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