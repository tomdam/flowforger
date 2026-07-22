/**
 * Example: Dataverse — Batch Operations (Atomic Changeset)
 *
 * Executes 4 operations as a single atomic changeset: create an account,
 * create a contact linked to it via $1 reference, update the account, and
 * delete a contact. All-or-nothing transactional semantics.
 */

@Flow('dv-batch-operations')
class DvBatchOperations {
  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.dataverse.ExecuteChangeset('ExecuteAtomicBatch', {
      requests: [
        {
          method: 'POST',
          entityName: 'accounts',
          body: { name: 'Contoso Ltd', revenue: 1000000 },
          contentId: '1',
        },
        {
          method: 'POST',
          entityName: 'contacts',
          body: {
            firstname: 'John',
            lastname: 'Doe',
            emailaddress1: 'john@contoso.com',
            'parentcustomerid_account@odata.bind': '$1',
          },
          contentId: '2',
        },
        {
          method: 'PATCH',
          entityName: 'accounts',
          recordId: '00000000-0000-0000-0000-000000000001',
          body: { revenue: 2000000 },
          contentId: '3',
        },
        {
          method: 'DELETE',
          entityName: 'contacts',
          recordId: '00000000-0000-0000-0000-000000000002',
          contentId: '4',
        },
      ],
    });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      schemaVersion: '1.0.0.0',
    };
    ctx.flow.connectionReferences = {
      shared_commondataserviceforapps: { runtimeUrl: '' },
    };
    ctx.flow.parameters = {
      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },
    };
  }
}
