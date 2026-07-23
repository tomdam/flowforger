/**
 * Example: Dataverse — Dataverse Search (GetRelevantRows)
 *
 * Three search variants: across all tables, scoped to a single table, and
 * scoped with filter + ordering.
 */

@Flow('dv-search')
class DvSearch {
  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.dataverse.GetRelevantRows('SearchAllTables', {
      searchText: 'Contoso',
      top: 50,
    });

    await ctx.connectors.dataverse.GetRelevantRows('SearchAccountsOnly', {
      searchText: 'manufacturing',
      entities: ['account'],
      top: 10,
    });

    await ctx.connectors.dataverse.GetRelevantRows('SearchWithFilter', {
      searchText: 'john doe',
      entities: ['contact', 'lead'],
      filter: 'statecode eq 0',
      top: 25,
      orderby: 'createdon desc',
    });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      schemaVersion: '1.0.0.0',
    };
    ctx.flow.connectionReferences = {
      shared_commondataserviceforapps: { apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' },
    };
    ctx.flow.parameters = {
      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },
    };
  }
}
