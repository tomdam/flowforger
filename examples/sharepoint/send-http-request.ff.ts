@Flow("SharePoint Send HTTP Request")
class SharePoint_Send_HTTP_Request {
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

    await ctx.connectors.sharepoint.SendHttpRequest("GetSiteInformation", {
      dataset: ctx.variables("siteUrl"),
      uri: "/_api/web?$select=Title,Url,Created,Language",
      method: "GET"
    });
    await ctx.connectors.sharepoint.SendHttpRequest("GetCurrentUser", {
      dataset: ctx.variables("siteUrl"),
      uri: "/_api/web/currentuser",
      method: "GET"
    });
    await ctx.connectors.sharepoint.SendHttpRequest("CreateCustomListItem", {
      dataset: ctx.variables("siteUrl"),
      uri: "/_api/web/lists/getbytitle('Custom List')/items",
      method: "POST",
      headers: { "Content-Type": "application/json;odata=nometadata" },
      body: {
        __metadata: { type: "SP.Data.Custom_x0020_ListListItem" },
        Title: "Created via HTTP Request",
        CustomField: "Custom value"
      }
    });
    await ctx.compose("Summary", {
      siteInfo: ctx.body('GetSiteInformation').body,
      currentUser: ctx.body('GetCurrentUser').body,
      createdItem: ctx.body('CreateCustomListItem').body
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