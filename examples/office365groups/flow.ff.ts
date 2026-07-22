/**
 * Example: List Office 365 Groups and Members
 *
 * Daily recurrence that lists the top 10 Office 365 groups, then iterates
 * each group to list its members and log the result.
 */

@Flow('office365groups-list-members')
class Office365GroupsListMembers {
  @RecurrenceTrigger({ frequency: 'Day', interval: 1 })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.office365groups.ListGroups('ListGroups', { top: 10 });

    /** @action ForEachGroup @type foreach */
    for (const _group of ctx.eval(`@body('ListGroups')?['value']`) ?? []) {
      await ctx.connectors.office365groups.ListGroupMembers('ListGroupMembers', {
        groupId: ctx.eval(`@items('ForEachGroup')?['id']`),
      });

      await ctx.compose('LogMembers', ctx.eval(`@body('ListGroupMembers')`));
    }
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      schemaVersion: '1.0.0.0',
    };
    ctx.flow.connectionReferences = {
      shared_office365groups: { runtimeUrl: '' },
    };
    ctx.flow.parameters = {
      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },
    };
  }
}
