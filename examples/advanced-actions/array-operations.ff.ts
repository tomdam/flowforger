/**
 * Example: Array Operations
 *
 * Demonstrates array variable initialization, appending items in loops,
 * union/intersection of arrays, filtering with conditionals, and
 * building result sets from multiple sources.
 */

@Flow('ArrayOperations')
class ArrayOperations {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize_highPriority */
    let highPriority: any[] = [];

    /** @action Initialize_lowPriority */
    let lowPriority: any[] = [];

    /** @action Initialize_processedIds */
    let processedIds: any[] = [];

    // Get tasks from trigger body
    await ctx.compose('AllTasks', ctx.triggerBody()?.['tasks']);

    // Categorize tasks by priority using a loop + if
    /** @action CategorizeLoop @type foreach */
    for (const task of ctx.outputs('AllTasks') ?? []) {
      /** @action CheckPriority @type if */
      if (task?.['priority'] === 'high') {
        // Append to high priority array
        /** @action AppendHigh */
        highPriority = ctx.eval(`@union(variables('highPriority'), createArray(items('CategorizeLoop')))`);
      } else {
        // Append to low priority array
        /** @action AppendLow */
        lowPriority = ctx.eval(`@union(variables('lowPriority'), createArray(items('CategorizeLoop')))`);
      }

      // Track all processed IDs
      /** @action TrackId */
      processedIds = ctx.eval(`@union(variables('processedIds'), createArray(items('CategorizeLoop')?['id']))`);
    }


    // Get additional urgent tasks from a second source
    await ctx.compose('UrgentTasks', ctx.triggerBody()?.['urgentTasks']);

    // Merge high priority with urgent tasks using union (deduplicates)
    await ctx.compose('MergedHighPriority', ctx.union(
      ctx.variables('highPriority'),
      ctx.outputs('UrgentTasks')
    ));

    // Find tasks that appear in both sources using intersection
    await ctx.compose('OverlappingTasks', ctx.intersection(
      ctx.variables('highPriority'),
      ctx.outputs('UrgentTasks')
    ));

    // Count results
    await ctx.compose('Stats', {
      totalProcessed: ctx.length(ctx.variables('processedIds')),
      highPriorityCount: ctx.length(ctx.outputs('MergedHighPriority')),
      lowPriorityCount: ctx.length(ctx.variables('lowPriority')),
      overlappingCount: ctx.length(ctx.outputs('OverlappingTasks'))
    });

    // Process merged high priority items in a second loop
    /** @action ProcessHighPriority @type foreach */
    for (const item of ctx.outputs('MergedHighPriority') ?? []) {
      await ctx.compose('ProcessedItem', {
        id: item?.['id'],
        title: item?.['title'],
        processed: true
      });
    }

    await ctx.response('Response', 200, {
      stats: ctx.outputs('Stats'),
      highPriority: ctx.outputs('MergedHighPriority'),
      lowPriority: ctx.variables('lowPriority'),
      overlapping: ctx.outputs('OverlappingTasks'),
      allIds: ctx.variables('processedIds')
    });
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
