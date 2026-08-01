/**
 * Example: JSON Parsing
 *
 * Demonstrates parsing JSON strings, extracting nested fields,
 * conditional logic based on parsed data, and building transformed output.
 */

@Flow('JsonParsing')
class JsonParsing {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    let validRecords: any[] = [];

    let errorMessages: any[] = [];

    // The trigger body contains raw JSON strings that need parsing
    await ctx.compose('RawPayloads', ctx.triggerBody()?.['payloads']);

    /** @action ParseEachPayload */
    for (const rawItem of ctx.outputs('RawPayloads') ?? []) {
      // Parse the JSON string into an object
      await ctx.compose('ParsedData', ctx.json(rawItem?.['jsonString']));

      // Validate required fields exist
      /** @action ValidateFields */
      if (ctx.not(ctx.empty(ctx.outputs('ParsedData')?.['name']))) {
        // Extract and transform the parsed record
        await ctx.compose('TransformedRecord', {
          fullName: ctx.outputs('ParsedData')?.['name'],
          email: ctx.outputs('ParsedData')?.['contact']?.['email'],
          age: ctx.outputs('ParsedData')?.['age'],
          source: rawItem?.['source']
        });

        // Check age-based category
        /** @action CheckAge */
        if (ctx.greaterOrEquals(ctx.outputs('ParsedData')?.['age'], 18)) {
          await ctx.compose('AgeCategory', 'adult');
        } else {
          await ctx.compose('AgeCategoryMinor', 'minor');
        }

        validRecords = ctx.eval(`@union(variables('validRecords'), createArray(outputs('TransformedRecord')))`);
      } else {
        // Record is invalid — capture error
        await ctx.compose('ErrorEntry', {
          source: rawItem?.['source'],
          reason: 'Missing required field: name'
        });

        errorMessages = ctx.eval(`@union(variables('errorMessages'), createArray(outputs('ErrorEntry')))`);
      }
    }

    // Build final summary
    await ctx.compose('Summary', {
      totalReceived: ctx.length(ctx.outputs('RawPayloads')),
      validCount: ctx.length(ctx.variables('validRecords')),
      errorCount: ctx.length(ctx.variables('errorMessages'))
    });

    // Decide response status based on errors
    /** @action CheckForErrors */
    if (ctx.greater(ctx.length(ctx.variables('errorMessages')), 0)) {
      await ctx.response('PartialResponse', 207, {
        summary: ctx.outputs('Summary'),
        valid: ctx.variables('validRecords'),
        errors: ctx.variables('errorMessages')
      });
    } else {
      await ctx.response('SuccessResponse', 200, {
        summary: ctx.outputs('Summary'),
        valid: ctx.variables('validRecords')
      });
    }
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
