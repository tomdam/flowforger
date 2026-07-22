@Flow("SharePoint Send HTTP Request")
class SharePoint_Send_HTTP_Request {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.SendHttpRequest("Get site information", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      uri: "/_api/web?$select=Title,Url,Created,Language",
      method: "GET"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.SendHttpRequest("Get current user", {
      dataset: "https://contoso.sharepoint.com/sites/MySite",
      uri: "/_api/web/currentuser",
      method: "GET"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.SendHttpRequest("Create custom list item", {
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
      siteInfo: ctx.body('Get site information').body,
      currentUser: ctx.body('Get current user').body,
      createdItem: ctx.body('Create custom list item').body
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