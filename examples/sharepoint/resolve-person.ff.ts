@Flow("SharePoint Resolve Person")
class SharePoint_Resolve_Person {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "User email address" }
      },
      required: ["email"]
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    // Configuration for this example - edit to point at your own tenant.
    // In a production flow, prefer a flow parameter bound to an environment
    // variable (ctx.parameters("...")), or values passed in via the trigger payload.
    let siteUrl = "https://contoso.sharepoint.com/sites/MySite";

    await ctx.connectors.sharepoint.ResolvePerson("LookUpUserByEmail", {
      dataset: ctx.variables("siteUrl"),
      email: ctx.triggerBody().email
    });
    await ctx.compose("UserInformation", {
      userId: ctx.body('LookUpUserByEmail').Id,
      displayName: ctx.body('LookUpUserByEmail').Title,
      email: ctx.body('LookUpUserByEmail').Email,
      loginName: ctx.body('LookUpUserByEmail').LoginName,
      principalType: ctx.body('LookUpUserByEmail').PrincipalType
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