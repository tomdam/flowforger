/**
 * Example: Dataverse — Custom Actions (Bound and Unbound)
 *
 * Invokes Dataverse custom actions: bound (operate on a specific record like
 * CalculatePrice / WinOpportunity) and unbound (global like WhoAmI or custom
 * organization-level actions).
 */

@Flow('dv-custom-actions')
class DvCustomActions {
  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.dataverse.PerformBoundAction('CalculatePriceAction', {
      entityName: 'opportunities',
      recordId: '00000000-0000-0000-0000-000000000001',
      actionName: 'CalculatePrice',
      DiscountPercentage: 10,
    });

    await ctx.connectors.dataverse.PerformBoundAction('WinOpportunityAction', {
      entityName: 'opportunities',
      recordId: '00000000-0000-0000-0000-000000000001',
      actionName: 'WinOpportunity',
      Status: 3,
      OpportunityClose: {
        subject: 'Won the deal',
        actualrevenue: 100000,
        actualend: '2025-12-31',
      },
    });

    await ctx.connectors.dataverse.PerformUnboundAction('RetrieveCurrentUserAction', {
      actionName: 'WhoAmI',
    });

    await ctx.connectors.dataverse.PerformUnboundAction('CustomGlobalAction', {
      actionName: 'new_CustomGlobalAction',
      InputParam1: 'test value',
      InputParam2: 42,
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
