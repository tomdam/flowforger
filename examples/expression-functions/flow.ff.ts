/**
 * Example: Expression Functions Demo
 *
 * Demonstrates property-path access, action/output/body references, trigger and
 * parameter access, and conditional logic using Power Automate expression functions.
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

    await ctx.compose('ExtractUserName', ctx.eval(`@body('GetUserData').user.name`));
    await ctx.compose('CheckStatus', ctx.eval(`@actions('GetUserData').status`));
    await ctx.compose('GetUserEmail', ctx.eval(`@outputs('GetUserData').user.email`));
    await ctx.compose('GetTriggerData', ctx.triggerBody());
    await ctx.compose('GetParameter', ctx.parameters('myParam'));

    /** @action CheckAge @type if */
    if (ctx.eval(`@greater(body('GetUserData').user.age, 25)`)) {
      await ctx.compose('AgeMessage', ctx.eval(`@concat('User is older than 25: ', body('GetUserData').user.name)`));
    } else {
      await ctx.compose('AgeMessage2', ctx.eval(`@concat('User is 25 or younger: ', body('GetUserData').user.name)`));
    }

    /** @action CheckSuccess @type if */
    if (ctx.eval(`@equals(actions('GetUserData').status, 'Succeeded')`)) {
      await ctx.compose('SuccessMessage', `'GetUserData action succeeded!'`);
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
