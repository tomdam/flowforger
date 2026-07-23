@Flow("SharePoint Send HTTP Request")
class SharePoint_Send_HTTP_Request {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.SendHttpRequest("GetSiteInformation", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      uri: "/_api/web?$select=Title,Url,Created,Language",
      method: "GET"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.SendHttpRequest("GetCurrentUser", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      uri: "/_api/web/currentuser",
      method: "GET"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.SendHttpRequest("CreateCustomListItem", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      uri: "/_api/web/lists/getbytitle('Custom List')/items",
      method: "POST",
      headers: { "Content-Type": "application/json;odata=nometadata" },
      body: {
        __metadata: { type: "SP.Data.Custom_x0020_ListListItem" },
        Title: "Created via HTTP Request",
        CustomField: "Custom value"
      }
    });
    /** @runAfter trigger */
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