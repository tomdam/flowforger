@Flow("SharePoint Grant Access")
class SharePoint_Grant_Access {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GrantAccess("Grant view access to user", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      itemId: "b8c2e5f7-3456-4a7b-9012-3c4d5e6f7a8b",
      recipients: "user@contoso.com",
      roleValue: "view",
      sendEmail: true,
      emailSubject: "Document shared with you",
      emailBody: "I've shared this document with you. Please review at your earliest convenience."
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GrantAccess("Grant edit access to multiple users", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      itemId: "b8c2e5f7-3456-4a7b-9012-3c4d5e6f7a8b",
      recipients: "user1@contoso.com;user2@contoso.com;user3@contoso.com",
      roleValue: "edit",
      sendEmail: true,
      requireSignIn: true
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GrantAccess("Grant owner access", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      itemId: "b8c2e5f7-3456-4a7b-9012-3c4d5e6f7a8b",
      recipients: "admin@contoso.com",
      roleValue: "owner",
      sendEmail: false
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