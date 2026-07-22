@Flow("SharePoint Advanced Discovery Workflow")
class SharePoint_Advanced_Discovery_Workflow {
  @ManualTrigger()
  trigger(ctx: FlowContext) {
    return {
      schema: {
      type: "object",
      properties: { siteUrl: { type: "string" }, userEmail: { type: "string" } },
      required: ["siteUrl", "userEmail"]
    },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize site URL */
    let siteUrl: string = ctx.triggerBody().siteUrl;
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.SendHttpRequest("Get site metadata", {
      dataset: ctx.variables('siteUrl'),
      uri: "/_api/web?$select=Title,Description,Created,ServerRelativeUrl",
      method: "GET"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetLists("Get all lists", { dataset: ctx.variables('siteUrl') });
    /** @runAfter trigger */
    await ctx.filterArray("Get document libraries", ctx.body('Get all lists').value, "@and(equals(item().BaseType, 1), equals(item().Hidden, false))");
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.ResolvePerson("Resolve user", {
      dataset: ctx.variables('siteUrl'),
      email: ctx.triggerBody().userEmail
    });
    /** @action Process each library @type foreach @runAfter trigger */
    for (const item of ctx.body('Get document libraries')) {
      await ctx.connectors.sharepoint.GetListViews("Get library views", {
        dataset: ctx.variables('siteUrl'),
        table: ctx.items('Process each library').Id
      });
      /** @runAfter first */
      await ctx.compose("Library info", {
        libraryName: ctx.items('Process each library').Title,
        libraryId: ctx.items('Process each library').Id,
        itemCount: ctx.items('Process each library').ItemCount,
        viewCount: ctx.body('Get library views').value.length,
        created: ctx.items('Process each library').Created
      });
    }
    /** @runAfter trigger */
    await ctx.compose("Discovery summary", {
      site: {
        title: ctx.body('Get site metadata').body.Title,
        description: ctx.body('Get site metadata').body.Description,
        created: ctx.body('Get site metadata').body.Created,
        url: ctx.body('Get site metadata').body.ServerRelativeUrl
      },
      statistics: {
        totalLists: ctx.body('Get all lists').value.length,
        documentLibraries: ctx.body('Get document libraries').length
      },
      user: {
        id: ctx.body('Resolve user').Id,
        displayName: ctx.body('Resolve user').Title,
        email: ctx.body('Resolve user').Email
      },
      libraries: ctx.body('Get document libraries')
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