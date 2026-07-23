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
    /** @action InitializeSiteURL */
    let siteUrl: string = ctx.triggerBody().siteUrl;
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.SendHttpRequest("GetSiteMetadata", {
      dataset: ctx.variables('siteUrl'),
      uri: "/_api/web?$select=Title,Description,Created,ServerRelativeUrl",
      method: "GET"
    });
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.GetLists("GetAllLists", { dataset: ctx.variables('siteUrl') });
    /** @runAfter trigger */
    await ctx.filterArray("Get document libraries", ctx.body('GetAllLists').value, "@and(equals(item().BaseType, 1), equals(item().Hidden, false))");
    /** @runAfter trigger */
    await ctx.connectors.sharepoint.ResolvePerson("ResolveUser", {
      dataset: ctx.variables('siteUrl'),
      email: ctx.triggerBody().userEmail
    });
    /** @action ProcessEachLibrary @type foreach @runAfter trigger */
    for (const item of ctx.body('Get document libraries')) {
      await ctx.connectors.sharepoint.GetListViews("GetLibraryViews", {
        dataset: ctx.variables('siteUrl'),
        table: ctx.items('ProcessEachLibrary').Id
      });
      /** @runAfter first */
      await ctx.compose("LibraryInfo", {
        libraryName: ctx.items('ProcessEachLibrary').Title,
        libraryId: ctx.items('ProcessEachLibrary').Id,
        itemCount: ctx.items('ProcessEachLibrary').ItemCount,
        viewCount: ctx.body('GetLibraryViews').value.length,
        created: ctx.items('ProcessEachLibrary').Created
      });
    }
    /** @runAfter trigger */
    await ctx.compose("DiscoverySummary", {
      site: {
        title: ctx.body('GetSiteMetadata').body.Title,
        description: ctx.body('GetSiteMetadata').body.Description,
        created: ctx.body('GetSiteMetadata').body.Created,
        url: ctx.body('GetSiteMetadata').body.ServerRelativeUrl
      },
      statistics: {
        totalLists: ctx.body('GetAllLists').value.length,
        documentLibraries: ctx.body('Get document libraries').length
      },
      user: {
        id: ctx.body('ResolveUser').Id,
        displayName: ctx.body('ResolveUser').Title,
        email: ctx.body('ResolveUser').Email
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
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}