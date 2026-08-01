@Flow("SharePoint Grant Access")
class SharePoint_Grant_Access {
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
    let recipientEmail = "user@contoso.com";

    await ctx.connectors.sharepoint.GrantAccess("GrantViewAccessToUser", {
      dataset: ctx.variables("siteUrl"),
      itemId: ctx.variables("fileId"),
      recipients: ctx.variables("recipientEmail"),
      roleValue: "view",
      sendEmail: true,
      emailSubject: "Document shared with you",
      emailBody: "I've shared this document with you. Please review at your earliest convenience."
    });
    await ctx.connectors.sharepoint.GrantAccess("GrantEditAccessToMultipleUsers", {
      dataset: ctx.variables("siteUrl"),
      itemId: ctx.variables("fileId"),
      recipients: "user1@contoso.com;user2@contoso.com;user3@contoso.com",
      roleValue: "edit",
      sendEmail: true,
      requireSignIn: true
    });
    await ctx.connectors.sharepoint.GrantAccess("GrantOwnerAccess", {
      dataset: ctx.variables("siteUrl"),
      itemId: ctx.variables("fileId"),
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
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}