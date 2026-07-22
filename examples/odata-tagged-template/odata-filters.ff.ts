/**
 * Example: OData Filters — Builder and Tagged Template Syntax
 *
 * Demonstrates the two ways to write OData $filter expressions for Dataverse
 * queries: the fluent builder API (ctx.odata.and/eq/gt/...) and the tagged
 * template syntax (ctx.odata`...`), which compiles familiar TypeScript-style
 * operators (==, !=, &&, ||, !, >=) to OData.
 */

@Flow('odata-filter-examples')
export class ODataFilterExamples {
  @ManualTrigger()
  @Action()
  async run(ctx: FlowContext) {
    // Builder syntax: compose filters from ctx.odata.* functions
    await ctx.connectors.dataverse.ListRecords('GetRecordsBuilderSyntax', {
      entityName: 'accounts',
      '$filter': ctx.odata.and(
        ctx.odata.eq('statecode', 0),
        ctx.odata.eq('statuscode', ctx.parameters('StatusValue')),
        ctx.odata.gt('revenue', ctx.parameters('MinAmount'))
      ),
      '$top': 10,
    });

    // Tagged template: simple comparison
    await ctx.connectors.dataverse.ListRecords('GetRecordsSimple', {
      entityName: 'accounts',
      '$filter': ctx.odata`statecode == 0 && statuscode != null`,
      '$top': 10,
    });

    // Tagged template: interpolate flow parameters
    await ctx.connectors.dataverse.ListRecords('GetRecordsWithParams', {
      entityName: 'accounts',
      '$filter': ctx.odata`statecode == 0 && statuscode == ${ctx.parameters('StatusValue')} && revenue > ${ctx.parameters('MinAmount')}`,
      '$top': 10,
    });

    // Tagged template: grouped conditions with || and parentheses
    await ctx.connectors.dataverse.ListRecords('GetRecordsComplex', {
      entityName: 'accounts',
      '$filter': ctx.odata`(statecode == 0 || statecode == 1) && (revenue >= ${ctx.parameters('MinAmount')} || customertype == 3)`,
      '$top': 10,
    });

    // Tagged template: NOT operator
    await ctx.connectors.dataverse.ListRecords('GetRecordsWithNot', {
      entityName: 'accounts',
      '$filter': ctx.odata`statecode == 0 && !(statuscode == 2)`,
      '$top': 10,
    });

    // Fetch a record, then use its output in the next query's filter
    const result = await ctx.connectors.dataverse.ListRecords('GetActiveAccounts', {
      entityName: 'accounts',
      '$filter': ctx.odata`statecode == 0`,
      '$top': 1,
    });

    await ctx.connectors.dataverse.ListRecords('GetRelatedRecords', {
      entityName: 'contacts',
      '$filter': ctx.odata`_parentcustomerid_value == ${ctx.body('GetActiveAccounts')?['value']?.[0]?.['accountid']}`,
      '$top': 10,
    });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.parameters = {
      StatusValue: { type: 'String', defaultValue: 'Active' },
      MinAmount: { type: 'Int', defaultValue: 100 },
    };

    ctx.flow.connectionReferences = {
      'shared_commondataserviceforapps': {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
        connectionReferenceLogicalName: 'cr_dataverse',
      },
    };
  }
}
