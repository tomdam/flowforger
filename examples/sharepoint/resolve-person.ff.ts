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
    await ctx.connectors.sharepoint.ResolvePerson("Look up user by email", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      email: ctx.triggerBody().email
    });
    /** @runAfter trigger */
    await ctx.compose("User information", {
      userId: ctx.body('Look up user by email').Id,
      displayName: ctx.body('Look up user by email').Title,
      email: ctx.body('Look up user by email').Email,
      loginName: ctx.body('Look up user by email').LoginName,
      principalType: ctx.body('Look up user by email').PrincipalType
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