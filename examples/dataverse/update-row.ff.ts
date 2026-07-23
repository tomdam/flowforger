/**
 * Example: Dataverse — Update Row
 *
 * Updates a single field on an existing account record. Uses UpdateOnlyRecord
 * (PATCH semantics — only specified fields are modified).
 */

@Flow('dv-update-row')
class DvUpdateRow {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.dataverse.UpdateOnlyRecord('UpdateAccount', {
      entityName: 'accounts',
      recordId: '<GUID>',
      'item/name': 'Updated Name',
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
