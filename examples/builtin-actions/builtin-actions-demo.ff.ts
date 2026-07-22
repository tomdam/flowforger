/**
 * Example: Built-in Actions Demo
 *
 * Comprehensive demo of FlowForger's built-in actions: variables (init/set/
 * increment/decrement/append), data operations (compose/join/select/filterArray/
 * parseJson), table generation (CSV/HTML), control flow, and delay.
 */

@Flow('BuiltinActionsDemo')
class BuiltinActionsDemo {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action InitCounter */
    let counter: number = 0;

    /** @action InitItems */
    let items: any[] = [];

    /** @action InitMessage */
    let message: string = 'Hello';

    /** @action SetCounter */
    counter = 10;

    /** @action IncrementCounter */
    counter += 5;

    /** @action DecrementCounter */
    counter -= 3;

    /** @action AppendItem1 */
    items.push('apple');

    /** @action AppendItem2 */
    items.push('banana');

    /** @action AppendItem3 */
    items.push('cherry');

    await ctx.appendToStringVariable('message', ' World!');

    await ctx.compose('ComposeData', {
      fruits: ctx.eval(`@variables('items')`),
      count: ctx.eval(`@variables('counter')`),
      greeting: ctx.eval(`@variables('message')`),
    });

    await ctx.join('JoinFruits', ctx.variables('items'), ', ');

    await ctx.select('SelectUppercase', ctx.variables('items'), {
      fruit: ctx.eval(`@item()`),
      uppercase: ctx.eval(`@toUpper(item())`),
    });

    await ctx.filterArray('FilterLongNames', ctx.variables('items'), `@greater(length(item()), 5)`);

    await ctx.parseJson('ParseJsonData', '{"name":"John","age":30}');

    await ctx.createCsvTable('CreateCsvFromItems', ctx.variables('items'));

    await ctx.createHtmlTable('CreateHtmlFromData', ctx.eval(`@outputs('SelectUppercase')`));

    /** @action CheckCounter @type if */
    if (ctx.eval(`@greater(variables('counter'), 10)`)) {
      await ctx.response('SuccessResponse', 200, {
        status: 'success',
        counter: ctx.eval(`@variables('counter')`),
        message: ctx.eval(`@variables('message')`),
      });
    } else {
      await ctx.response('LowCounterResponse', 200, {
        status: 'low',
        counter: ctx.eval(`@variables('counter')`),
      });
    }

    await ctx.delay('Wait5Seconds', 5, 'Second');
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      schemaVersion: '1.0.0.0',
    };
    ctx.flow.connectionReferences = {};
    ctx.flow.parameters = {
      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },
    };
  }
}
