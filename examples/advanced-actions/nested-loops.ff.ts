/**
 * Example: Nested Loops
 *
 * Demonstrates nested foreach loops processing a matrix of departments
 * and their employees, building a flat summary array.
 */

@Flow('NestedLoops')
class NestedLoops {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize_totalCount */
    let totalCount: number = 0;

    /** @action Initialize_summaries */
    let summaries: any[] = [];

    // Extract departments array from trigger
    await ctx.compose('Departments', ctx.triggerBody()?.['departments']);

    /** @action LoopDepartments @type foreach */
    for (const dept of ctx.outputs('Departments') ?? []) {
      // Compose department info for reference inside inner loop
      await ctx.compose('CurrentDept', dept?.['name']);

      /** @action LoopEmployees @type foreach */
      for (const emp of dept?.['employees'] ?? []) {
        // Build a summary entry for each employee
        await ctx.compose('EmployeeSummary', {
          department: ctx.outputs('CurrentDept'),
          employee: emp?.['name'],
          role: emp?.['role']
        });

        /** @action IncrementTotal */
        totalCount = totalCount + 1;

        /** @action AppendSummary */
        summaries = ctx.eval(`@union(variables('summaries'), createArray(outputs('EmployeeSummary')))`);
      }
    }

    await ctx.compose('Result', {
      totalEmployees: ctx.variables('totalCount'),
      summaries: ctx.variables('summaries')
    });

    await ctx.response('Response', 200, ctx.outputs('Result'));
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
      contentVersion: "1.0.0.0",
      schemaVersion: "1.0.0.0",
    };
    ctx.flow.connectionReferences = {};
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}
