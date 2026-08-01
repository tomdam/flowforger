/**
 * Example: Dataverse — Relationships
 *
 * Upserts a contact, associates it with an account via the
 * `contact_customer_accounts` N:1 relationship, then disassociates it.
 */

@Flow('dv-relationships')
class DvRelationships {
  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    // Configuration - edit to point at records in your own environment.
    // In a production flow, prefer a flow parameter bound to an environment
    // variable (ctx.parameters('...')), or values passed in via the trigger payload.
    let contactId = '00000000-0000-0000-0000-000000000001';
    let accountId = '00000000-0000-0000-0000-000000000002';

    await ctx.connectors.dataverse.UpsertRecord('UpsertContact', {
      entityName: 'contacts',
      recordId: ctx.variables('contactId'),
      'item/firstname': 'John',
      'item/lastname': 'Doe',
      'item/emailaddress1': 'john.doe@example.com',
    });

    await ctx.connectors.dataverse.AssociateEntities('AssociateContactToAccount', {
      entityName: 'accounts',
      recordId: ctx.variables('accountId'),
      relationshipName: 'contact_customer_accounts',
      relatedEntityName: 'contacts',
      relatedRecordId: ctx.variables('contactId'),
    });

    await ctx.connectors.dataverse.DisassociateEntities('DisassociateContactFromAccount', {
      entityName: 'accounts',
      recordId: ctx.variables('accountId'),
      relationshipName: 'contact_customer_accounts',
      relatedRecordId: ctx.variables('contactId'),
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
