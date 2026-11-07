/**
 * Example: Built-in Actions Demo
 *
 * One flow exercising FlowForger's connector-free actions: variables (initialize,
 * set, increment, decrement, append to array, append to string), data operations
 * (Compose, Join, Select, Filter array, Parse JSON), table generation (HTML and CSV),
 * a Delay, and an if/else that answers the request with a different Response per
 * branch. Everything runs locally without credentials.
 */

@Flow('BuiltinActionsDemo')
class BuiltinActionsDemo {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    // Variable statements carry no @action here, so the transformer names them:
    // Initialize_counter, Set_counter, Increment_counter, Decrement_counter,
    // Append_to_items, Append_message
    let counter: number = 0;
    let items: any[] = [];
    let message: string = 'Hello';

    counter = 10;
    counter += 5;
    counter -= 3;

    items.push('apple');
    items.push('banana');
    items.push('cherry');

    message += ' World!';

    // A Compose action's result is read with ctx.outputs()
    await ctx.compose('ComposeData', {
      received: ctx.triggerBody()?.['testData'],
      fruits: ctx.variables('items'),
      count: ctx.variables('counter'),
      greeting: ctx.variables('message'),
    });

    // Data operations: their result is read with ctx.body()
    await ctx.join('JoinFruits', ctx.variables('items'), ', ');

    await ctx.select('SelectUppercase', ctx.variables('items'), {
      fruit: ctx.item(),
      uppercase: ctx.toUpper(ctx.item()),
    });

    await ctx.filterArray('FilterLongNames', ctx.variables('items'), ctx.greater(ctx.length(ctx.item()), 5));

    await ctx.parseJson('ParseJsonData', '{"name":"John","age":30}');

    // Tables: automatic columns need an array of objects (the Select output above);
    // an array of strings needs explicit columns, as in the cloud
    await ctx.createHtmlTable('CreateHtmlFromData', ctx.body('SelectUppercase'));

    await ctx.createCsvTable('CreateCsvFromItems', ctx.variables('items'), [
      { header: 'Fruit', value: ctx.item() },
      { header: 'Length', value: ctx.length(ctx.item()) },
    ]);

    await ctx.delay('Wait1Second', 1, 'Second');

    /** @action CheckCounter */
    if (ctx.greater(ctx.variables('counter'), 10)) {
      await ctx.response('SuccessResponse', 200, {
        status: 'success',
        counter: ctx.variables('counter'),
        message: ctx.variables('message'),
        csv: ctx.body('CreateCsvFromItems'),
      });
    } else {
      await ctx.response('LowCounterResponse', 200, {
        status: 'low',
        counter: ctx.variables('counter'),
      });
    }
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
