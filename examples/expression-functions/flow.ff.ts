/**
 * Example: Expression Functions Demo
 *
 * The three ways to read earlier data in a flow — outputs(), body() and actions() —
 * plus trigger and parameter access and property paths. Several actions appear
 * twice: once with a typed ctx helper and once as a raw Power Automate expression in
 * ctx.eval(). Both forms compile to the same expression; pick whichever reads better.
 */

@Flow('expression-functions-demo')
class ExpressionFunctionsDemo {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('GetUserData', {
      user: { name: 'John Doe', email: 'john@example.com', age: 30 },
      status: 'active',
    });

    // outputs('X') is the value of a Compose. These two lines compile to the same thing.
    await ctx.compose('ExtractUserName', ctx.outputs('GetUserData')?.['user']?.['name']);
    await ctx.compose('ExtractUserEmail', ctx.eval(`@outputs('GetUserData')?['user']?['email']`));

    // actions('X') is the run record of an action: status, code, startTime, inputs, outputs, error
    await ctx.compose('CheckStatus', ctx.eval(`@actions('GetUserData')?['status']`));

    // body('X') is outputs('X')?['body']: the response of an HTTP, connector or child-flow call
    await ctx.http('CallHttpBin', { method: 'GET', url: 'https://httpbin.org/get?demo=1' });
    await ctx.compose('ExtractQueryArg', ctx.body('CallHttpBin')?.['args']?.['demo']);
    await ctx.compose('ExtractStatusCode', ctx.eval(`@outputs('CallHttpBin')?['statusCode']`));

    // The trigger: triggerBody() is the payload, triggerOutputs() has headers and body
    await ctx.compose('GetTriggerData', ctx.triggerBody());
    await ctx.compose('GetTriggerHeaders', ctx.eval(`@triggerOutputs()?['headers']`));

    // A flow parameter, by the exact key used in ctx.flow.parameters below
    await ctx.compose('GetParameter', ctx.parameters('myParam'));

    // Comparisons and string functions over property paths
    /** @action CheckAge */
    if (ctx.greater(ctx.outputs('GetUserData')?.['user']?.['age'], 25)) {
      await ctx.compose('AgeMessage', ctx.concat('User is older than 25: ', ctx.outputs('GetUserData')?.['user']?.['name']));
    } else {
      await ctx.compose('AgeMessageYoung', ctx.eval(`@concat('User is 25 or younger: ', outputs('GetUserData')?['user']?['name'])`));
    }

    /** @action CheckSuccess */
    if (ctx.eval(`@equals(actions('GetUserData')?['status'], 'Succeeded')`)) {
      await ctx.compose('SuccessMessage', 'GetUserData action succeeded!');
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
      myParam: { type: 'String', defaultValue: 'default value' },
    };
  }
}
