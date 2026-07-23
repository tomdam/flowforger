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
    await ctx.connectors.sharepoint.ResolvePerson("LookUpUserByEmail", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      email: ctx.triggerBody().email
    });
    /** @runAfter trigger */
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