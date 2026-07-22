@Flow("SharePoint Sharing Workflow")
class SharePoint_Sharing_Workflow {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        siteUrl: { type: "string", description: "SharePoint site URL" },
        libraryId: { type: "string", description: "Document library ID" },
        fileName: { type: "string", description: "Document name" },
        recipients: {
          type: "string",
          description: "Email addresses (semicolon separated)"
        }
      },
      required: ["siteUrl", "libraryId", "fileName", "recipients"]
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize site URL */
    let siteUrl: string = ctx.triggerBody().siteUrl;
    /** @action Initialize library ID @runAfter first */
    let libraryId: string = ctx.triggerBody().libraryId;
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CreateFile("Create document", {
      dataset: ctx.variables('siteUrl'),
      folderPath: "/Shared Documents",
      fileName: ctx.triggerBody().fileName,
      body: "This is a confidential document that needs to be shared securely."
    });
    /** @action Store file ID @runAfter first */
    let fileId: string = ctx.body('Create document').UniqueId;
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.CreateSharingLink("Create secure sharing link", {
      dataset: ctx.variables('siteUrl'),
      itemId: ctx.variables('fileId'),
      linkType: "view",
      scope: "organization",
      expirationDateTime: ctx.addDays(ctx.utcNow(), 7)
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GrantAccess("Grant edit access to recipients", {
      dataset: ctx.variables('siteUrl'),
      itemId: ctx.variables('fileId'),
      recipients: ctx.triggerBody().recipients,
      roleValue: "edit",
      sendEmail: true,
      emailSubject: `New document shared: ${ctx.triggerBody().fileName}`,
      emailBody: "A new document has been created and shared with you. You have edit permissions. The sharing link will expire in 7 days.",
      requireSignIn: true
    });
    /** @runAfter trigger */
    await ctx.delay("Wait for document review", 7, "Day");
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.StopSharing("Remove sharing after expiration", {
      dataset: ctx.variables('siteUrl'),
      itemId: ctx.variables('fileId')
    });
    /** @runAfter trigger */
    await ctx.compose("Summary", {
      message: "Document sharing workflow completed",
      fileId: ctx.variables('fileId'),
      fileName: ctx.triggerBody().fileName,
      sharingLink: ctx.body('Create secure sharing link').sharingLinkInfo,
      sharedWith: ctx.triggerBody().recipients,
      sharingRemoved: ctx.utcNow()
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