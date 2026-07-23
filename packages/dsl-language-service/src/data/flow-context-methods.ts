/**
 * FlowContext method definitions for autocomplete.
 * This file contains all ctx.* methods with their documentation.
 */

import type { MethodSignature } from '../types.js';

/**
 * All FlowContext methods organized by category.
 */
export const flowContextMethods: MethodSignature[] = [
  // ============================================
  // Reference Functions
  // ============================================
  {
    name: 'body',
    category: 'Reference',
    description: 'Get the body/output of a previous action.',
    parameters: [
      { name: 'actionName', type: 'string', description: 'Name of the action to reference' },
    ],
    returnType: 'T',
    examples: [
      "ctx.body<UserResponse>('GetUser').name",
      "ctx.body('GetItems').value",
    ],
  },
  {
    name: 'outputs',
    category: 'Reference',
    description: 'Get the outputs of a previous action (includes headers, statusCode, etc.).',
    parameters: [
      { name: 'actionName', type: 'string', description: 'Name of the action to reference' },
    ],
    returnType: 'T',
    examples: [
      "ctx.outputs('HttpRequest').headers",
    ],
  },
  {
    name: 'actions',
    category: 'Reference',
    description: 'Get the full action reference including execution status.',
    parameters: [
      { name: 'actionName', type: 'string', description: 'Name of the action to reference' },
    ],
    returnType: 'ActionReference',
    examples: [
      "if (ctx.actions('GetUser').status === 'Succeeded') { ... }",
    ],
  },
  {
    name: 'triggerBody',
    category: 'Reference',
    description: 'Get the trigger body (request payload for HTTP triggers).',
    parameters: [],
    returnType: 'T',
    examples: [
      'ctx.triggerBody<MyPayload>().id',
      'ctx.triggerBody().name',
    ],
  },
  {
    name: 'triggerOutputs',
    category: 'Reference',
    description: 'Get the trigger outputs (includes headers, queries, etc.).',
    parameters: [],
    returnType: 'T',
    examples: [
      'ctx.triggerOutputs().headers',
      "ctx.triggerOutputs().queries['id']",
    ],
  },
  {
    name: 'variables',
    category: 'Reference',
    description: 'Get a variable value.',
    parameters: [
      { name: 'name', type: 'string', description: 'Name of the variable' },
    ],
    returnType: 'T',
    examples: [
      "ctx.variables<number>('counter')",
    ],
  },
  {
    name: 'item',
    category: 'Reference',
    description: 'Get the current item in a foreach loop. In the DSL, use the loop variable directly (e.g., `record.name`) — it maps to `@item()` automatically.',
    parameters: [],
    returnType: 'T',
    examples: [
      "for (const record of ctx.body('GetItems').value) {\n  // use record.fieldName directly\n}",
    ],
  },
  {
    name: 'items',
    category: 'Reference',
    description: 'Get the current item from a named foreach loop (for nested loops). In the DSL, use the outer loop variable directly — it maps to `@items(\'LoopName\')` automatically.',
    parameters: [
      { name: 'loopName', type: 'string', description: 'Name of the foreach loop' },
    ],
    returnType: 'T',
    examples: [
      "for (const parent of parentList) {\n  for (const child of childList) {\n    // use parent.field or child.field directly\n  }\n}",
    ],
  },
  {
    name: 'parameters',
    category: 'Reference',
    description: 'Get a flow parameter value.',
    parameters: [
      { name: 'name', type: 'string', description: 'Name of the parameter' },
    ],
    returnType: 'T',
    examples: [
      "ctx.parameters<string>('ApiKey')",
    ],
  },
  {
    name: 'trigger',
    category: 'Reference',
    description: 'Get the trigger info object.',
    parameters: [],
    returnType: 'T',
    examples: [
      'ctx.trigger().name',
    ],
  },
  {
    name: 'workflow',
    category: 'Reference',
    description: 'Get workflow metadata (name, run id, etc.).',
    parameters: [],
    returnType: 'T',
    examples: [
      "ctx.workflow().run.name",
    ],
  },
  {
    name: 'connectors',
    category: 'Connector',
    description: 'Access connector operations (SharePoint, Dataverse, Office 365, etc.).',
    parameters: [],
    returnType: 'Connectors',
    examples: [
      "ctx.connectors.sharepoint.GetItems('GetTasks', { dataset: '...', table: '...' });",
      "ctx.connectors.dataverse.ListRows('GetAccounts', { entityName: 'accounts' });",
      "ctx.connectors.office365.SendEmail('Notify', { to: 'user@example.com', ... });",
    ],
  },
  {
    name: 'eval',
    category: 'Reference',
    description: 'Evaluate a Power Automate expression at runtime. Used for expressions that cannot be converted to TypeScript.',
    parameters: [
      { name: 'expression', type: 'string', description: 'The Power Automate expression string' },
    ],
    returnType: 'T',
    examples: [
      "ctx.eval<string>(\"@concat('Hello, ', body('GetUser').name)\")",
    ],
  },

  // ============================================
  // Built-in Actions
  // ============================================
  {
    name: 'http',
    category: 'Action',
    description: 'HTTP request action. Makes an HTTP call to an external API.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'inputs', type: 'HttpInputs', description: 'HTTP request configuration (method, url, headers, body)' },
    ],
    returnType: 'Promise<HttpResponse>',
    examples: [
      "await ctx.http('GetUser', {\n  method: 'GET',\n  url: 'https://api.example.com/users/1'\n});",
      "await ctx.http('CreateItem', {\n  method: 'POST',\n  url: 'https://api.example.com/items',\n  headers: { 'Content-Type': 'application/json' },\n  body: { name: 'New Item' }\n});",
    ],
  },
  {
    name: 'compose',
    category: 'Action',
    description: 'Compose action - creates a value that can be referenced later.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'value', type: 'any', description: 'The value to compose' },
    ],
    returnType: 'Promise<any>',
    examples: [
      "await ctx.compose('FullName', `${firstName} ${lastName}`);",
      "await ctx.compose('Config', { api: apiUrl, timeout: 30 });",
    ],
  },
  {
    name: 'saveFile',
    category: 'Action',
    description:
      'Save File (debug aid) - compiles to a Compose emitting a sentinel object. In the Maker portal this is an ordinary Compose with no special behavior; when run locally via the FlowForger engine, the host saves the file to disk (CLI) or offers a download (web).',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      {
        name: 'file',
        type: '{ contentType: string; content: string; fileName?: string; encoding?: "utf8" | "base64" }',
        description: 'File descriptor. Use encoding "base64" for binary content.',
      },
    ],
    returnType: 'Promise<any>',
    examples: [
      "await ctx.saveFile('Dump', { contentType: 'text/xml', content: xmlString });",
      "await ctx.saveFile('Report', { contentType: 'application/pdf', content: base64Pdf, encoding: 'base64', fileName: 'report.pdf' });",
    ],
  },
  {
    name: 'response',
    category: 'Action',
    description: 'Response action - returns an HTTP response (for HTTP-triggered flows).',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'statusCode', type: 'number', description: 'HTTP status code (200, 400, 500, etc.)' },
      { name: 'body', type: 'any', description: 'Response body', optional: true },
      { name: 'headers', type: 'Record<string, string>', description: 'Response headers', optional: true },
    ],
    returnType: 'Promise<void>',
    examples: [
      "await ctx.response('Success', 200, { message: 'OK' });",
      "await ctx.response('Error', 400, { error: 'Bad Request' }, { 'Content-Type': 'application/json' });",
    ],
  },
  {
    name: 'terminate',
    category: 'Action',
    description: 'Terminate action - ends the flow execution.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'runStatus', type: "'Succeeded' | 'Cancelled' | 'Failed'", description: 'The final status of the flow' },
      { name: 'runError', type: '{ code?: string; message?: string }', description: 'Error details (for Failed status)', optional: true },
    ],
    returnType: 'Promise<void>',
    examples: [
      "await ctx.terminate('EndSuccess', 'Succeeded');",
      "await ctx.terminate('EndError', 'Failed', { code: 'ERR001', message: 'Something went wrong' });",
    ],
  },
  {
    name: 'delay',
    category: 'Action',
    description: 'Delay action - wait for a specified duration.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'count', type: 'number', description: 'Duration count' },
      { name: 'unit', type: 'DelayUnit', description: "Time unit: 'Second' | 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month'" },
    ],
    returnType: 'Promise<void>',
    examples: [
      "await ctx.delay('Wait5Seconds', 5, 'Second');",
      "await ctx.delay('Wait1Hour', 1, 'Hour');",
    ],
  },
  {
    name: 'delayUntil',
    category: 'Action',
    description: 'Delay Until action - wait until a specified time.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'until', type: 'string', description: 'ISO 8601 timestamp to wait until' },
    ],
    returnType: 'Promise<void>',
    examples: [
      "await ctx.delayUntil('WaitUntilMidnight', '2024-01-01T00:00:00Z');",
    ],
  },
  {
    name: 'callWorkflow',
    category: 'Action',
    description: 'Call a child workflow.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'workflowReferenceName', type: 'string', description: 'Reference name of the child workflow' },
      { name: 'body', type: 'any', description: 'Request body to send to child workflow', optional: true },
      { name: 'headers', type: 'Record<string, string>', description: 'Request headers', optional: true },
    ],
    returnType: 'Promise<any>',
    examples: [
      "await ctx.callWorkflow('ProcessOrder', 'OrderProcessor', { orderId: 123 });",
    ],
  },
  {
    name: 'parseJson',
    category: 'Action',
    description: 'Parse JSON action - parse a JSON string into an object.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'content', type: 'any', description: 'The JSON string to parse' },
      { name: 'schema', type: 'object', description: 'JSON schema for validation', optional: true },
    ],
    returnType: 'Promise<T>',
    examples: [
      "await ctx.parseJson<MyType>('ParseResponse', jsonString);",
    ],
  },
  {
    name: 'join',
    category: 'Action',
    description: 'Join array elements into a string.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'from', type: 'any[]', description: 'Array to join' },
      { name: 'joinWith', type: 'string', description: 'Separator string' },
    ],
    returnType: 'Promise<string>',
    examples: [
      "await ctx.join('JoinNames', ['Alice', 'Bob', 'Charlie'], ', ');",
    ],
  },
  {
    name: 'select',
    category: 'Action',
    description: 'Select/map array elements to a new shape.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'from', type: 'any[]', description: 'Source array' },
      { name: 'selectMap', type: 'any', description: 'Mapping expression' },
    ],
    returnType: 'Promise<T[]>',
    examples: [
      "await ctx.select('SelectNames', users, { name: '@item().fullName' });",
    ],
  },
  {
    name: 'filter',
    category: 'Action',
    description: 'Filter an array based on a condition (alias of filterArray).',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'from', type: 'T[]', description: 'Source array' },
      { name: 'where', type: 'string', description: 'Filter expression' },
    ],
    returnType: 'Promise<T[]>',
    examples: [
      "await ctx.filter('FilterActive', users, \"@equals(item().status, 'active')\");",
    ],
  },
  {
    name: 'filterArray',
    category: 'Action',
    description: 'Filter an array based on a condition.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'from', type: 'T[]', description: 'Source array' },
      { name: 'where', type: 'string', description: 'Filter expression' },
    ],
    returnType: 'Promise<T[]>',
    examples: [
      "await ctx.filterArray('FilterActive', users, \"@equals(item().status, 'active')\");",
    ],
  },
  {
    name: 'createCsvTable',
    category: 'Action',
    description: 'Create CSV table from array.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'from', type: 'any[]', description: 'Source array' },
      { name: 'columns', type: 'Array<{ header: string; value: any }>', description: 'Column definitions', optional: true },
    ],
    returnType: 'Promise<string>',
    examples: [
      "await ctx.createCsvTable('CreateCSV', data);",
    ],
  },
  {
    name: 'createHtmlTable',
    category: 'Action',
    description: 'Create HTML table from array.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'from', type: 'any[]', description: 'Source array' },
      { name: 'columns', type: 'Array<{ header: string; value: any }>', description: 'Column definitions', optional: true },
    ],
    returnType: 'Promise<string>',
    examples: [
      "await ctx.createHtmlTable('CreateTable', data);",
    ],
  },
  {
    name: 'appendToStringVariable',
    category: 'Action',
    description: 'Append text to a string variable.',
    parameters: [
      { name: 'name', type: 'string', description: 'Name of the string variable to append to' },
      { name: 'value', type: 'string', description: 'Text to append' },
    ],
    returnType: 'Promise<void>',
    examples: [
      "await ctx.appendToStringVariable('message', ' World');",
      "await ctx.appendToStringVariable('log', ctx.body('GetData').text);",
    ],
  },

  // ============================================
  // Generic Connector Actions
  // ============================================
  {
    name: 'connector',
    category: 'Connector',
    description: 'Generic connector action for any connector/operation. Use this for connectors not in ctx.connectors.',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'connector', type: 'string', description: 'Connector name (e.g., "sharepoint", "dataverse")' },
      { name: 'operation', type: 'string', description: 'Operation name (e.g., "GetItems", "ListRecords")' },
      { name: 'params', type: 'ConnectorParams', description: 'Operation parameters' },
      { name: 'connectionReferenceName', type: 'string', description: 'Connection reference name', optional: true },
    ],
    returnType: 'Promise<any>',
    examples: [
      "await ctx.connector('GetItems', 'sharepoint', 'GetItems', { dataset: siteUrl, table: listId });",
    ],
  },
  {
    name: 'connectorWebhook',
    category: 'Connector',
    description: 'Connector webhook action (for approvals and other webhook-based connectors).',
    parameters: [
      { name: 'name', type: 'string', description: 'Unique name for this action' },
      { name: 'connector', type: 'string', description: 'Connector name' },
      { name: 'operation', type: 'string', description: 'Operation name' },
      { name: 'params', type: 'ConnectorParams', description: 'Operation parameters' },
      { name: 'connectionReferenceName', type: 'string', description: 'Connection reference name', optional: true },
    ],
    returnType: 'Promise<any>',
    examples: [
      "await ctx.connectorWebhook('WaitForApproval', 'approvals', 'StartAndWaitForAnApproval', {\n  title: 'Approve Request',\n  assignedTo: 'manager@example.com'\n});",
    ],
  },

  // ============================================
  // Date/Time Functions
  // ============================================
  {
    name: 'utcNow',
    category: 'DateTime',
    description: 'Get current UTC time as ISO 8601 string.',
    parameters: [
      { name: 'format', type: 'string', description: 'Output format (e.g., yyyy-MM-dd)', optional: true },
    ],
    returnType: 'string',
    examples: [
      'ctx.utcNow()',
      "ctx.utcNow('yyyy-MM-dd')",
    ],
  },
  {
    name: 'addDays',
    category: 'DateTime',
    description: 'Add days to a timestamp.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Base timestamp (ISO 8601)' },
      { name: 'days', type: 'number', description: 'Number of days to add (can be negative)' },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.addDays(ctx.utcNow(), 7)",
    ],
  },
  {
    name: 'addHours',
    category: 'DateTime',
    description: 'Add hours to a timestamp.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Base timestamp (ISO 8601)' },
      { name: 'hours', type: 'number', description: 'Number of hours to add (can be negative)' },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.addHours(ctx.utcNow(), 2)",
    ],
  },
  {
    name: 'addMinutes',
    category: 'DateTime',
    description: 'Add minutes to a timestamp.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Base timestamp (ISO 8601)' },
      { name: 'minutes', type: 'number', description: 'Number of minutes to add (can be negative)' },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.addMinutes(ctx.utcNow(), 30)",
    ],
  },
  {
    name: 'addSeconds',
    category: 'DateTime',
    description: 'Add seconds to a timestamp.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Base timestamp (ISO 8601)' },
      { name: 'seconds', type: 'number', description: 'Number of seconds to add (can be negative)' },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.addSeconds(ctx.utcNow(), 5)",
    ],
  },
  {
    name: 'formatDateTime',
    category: 'DateTime',
    description: 'Format a date/time string.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Timestamp to format' },
      { name: 'format', type: 'string', description: 'Format string (e.g., "yyyy-MM-dd")', optional: true },
      { name: 'locale', type: 'string', description: 'Locale for formatting', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.formatDateTime(ctx.utcNow(), 'yyyy-MM-dd')",
    ],
  },
  {
    name: 'convertFromUtc',
    category: 'DateTime',
    description: 'Convert a timestamp from UTC to a target timezone.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'UTC timestamp' },
      { name: 'timezone', type: 'string', description: 'Target timezone (e.g., "Pacific Standard Time")' },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.convertFromUtc(ctx.utcNow(), 'Pacific Standard Time')",
    ],
  },
  {
    name: 'convertTimeZone',
    category: 'DateTime',
    description: 'Convert a timestamp between timezones.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Source timestamp' },
      { name: 'sourceTimezone', type: 'string', description: 'Source timezone' },
      { name: 'targetTimezone', type: 'string', description: 'Target timezone' },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.convertTimeZone(timestamp, 'Eastern Standard Time', 'Pacific Standard Time')",
    ],
  },
  {
    name: 'convertToUtc',
    category: 'DateTime',
    description: 'Convert a timestamp to UTC.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Source timestamp' },
      { name: 'sourceTimezone', type: 'string', description: 'Source timezone' },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.convertToUtc(localTime, 'Pacific Standard Time')",
    ],
  },
  {
    name: 'dayOfMonth',
    category: 'DateTime',
    description: 'Get the day of month (1-31).',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Timestamp' },
    ],
    returnType: 'number',
    examples: [
      'ctx.dayOfMonth(ctx.utcNow())',
    ],
  },
  {
    name: 'dayOfWeek',
    category: 'DateTime',
    description: 'Get the day of week (0-6, Sunday = 0).',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Timestamp' },
    ],
    returnType: 'number',
    examples: [
      'ctx.dayOfWeek(ctx.utcNow())',
    ],
  },
  {
    name: 'dayOfYear',
    category: 'DateTime',
    description: 'Get the day of year (1-366).',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Timestamp' },
    ],
    returnType: 'number',
    examples: [
      'ctx.dayOfYear(ctx.utcNow())',
    ],
  },
  {
    name: 'startOfDay',
    category: 'DateTime',
    description: 'Get the start of the day (midnight).',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Timestamp' },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      'ctx.startOfDay(ctx.utcNow())',
    ],
  },
  {
    name: 'startOfHour',
    category: 'DateTime',
    description: 'Get the start of the hour.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Timestamp' },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      'ctx.startOfHour(ctx.utcNow())',
    ],
  },
  {
    name: 'startOfMonth',
    category: 'DateTime',
    description: 'Get the start of the month.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Timestamp' },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      'ctx.startOfMonth(ctx.utcNow())',
    ],
  },
  {
    name: 'getFutureTime',
    category: 'DateTime',
    description: 'Get a future time.',
    parameters: [
      { name: 'interval', type: 'number', description: 'Time interval' },
      { name: 'unit', type: 'string', description: "Time unit: 'Second', 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year'" },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.getFutureTime(1, 'Hour')",
    ],
  },
  {
    name: 'getPastTime',
    category: 'DateTime',
    description: 'Get a past time.',
    parameters: [
      { name: 'interval', type: 'number', description: 'Time interval' },
      { name: 'unit', type: 'string', description: "Time unit: 'Second', 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year'" },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.getPastTime(7, 'Day')",
    ],
  },
  {
    name: 'ticks',
    category: 'DateTime',
    description: 'Get ticks (100-nanosecond intervals since Jan 1, 0001).',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Timestamp' },
    ],
    returnType: 'number',
    examples: [
      'ctx.ticks(ctx.utcNow())',
    ],
  },

  // ============================================
  // Collection Functions
  // ============================================
  {
    name: 'createArray',
    category: 'Collection',
    description: 'Create an array from the given values. Emits `@createArray(...)`.',
    parameters: [
      { name: '...items', type: 'any[]', description: 'Values to put in the array' },
    ],
    returnType: 'T[]',
    examples: [
      'ctx.createArray(task)',
      "ctx.createArray(1, 2, 3)",
    ],
  },
  {
    name: 'union',
    category: 'Collection',
    description: 'Combine collections into one, removing duplicates. Works on arrays and objects. Emits `@union(...)`. Preserves the array type — do not wrap in ctx.braced() unless you want a string.',
    parameters: [
      { name: '...collections', type: 'any[]', description: 'Two or more collections to combine' },
    ],
    returnType: 'T',
    examples: [
      "ctx.union(highPriority, ctx.createArray(task))",
      "await ctx.compose('AllItems', ctx.union(arr1, arr2))",
    ],
  },
  {
    name: 'intersection',
    category: 'Collection',
    description: 'Return only the items present in all collections. Works on arrays and objects. Emits `@intersection(...)`.',
    parameters: [
      { name: '...collections', type: 'any[]', description: 'Two or more collections to intersect' },
    ],
    returnType: 'T',
    examples: [
      "ctx.intersection(ctx.variables('listA'), ctx.variables('listB'))",
    ],
  },
  {
    name: 'range',
    category: 'Collection',
    description: 'Generate an array of integers, starting at startIndex with count elements. Emits `@range(...)`.',
    parameters: [
      { name: 'startIndex', type: 'number', description: 'First integer in the array' },
      { name: 'count', type: 'number', description: 'Number of integers to generate' },
    ],
    returnType: 'number[]',
    examples: [
      'ctx.range(0, 10)',
    ],
  },
  {
    name: 'first',
    category: 'Collection',
    description: 'Get the first element of an array or the first character of a string. Emits `@first(...)`.',
    parameters: [
      { name: 'collection', type: 'any[] | string', description: 'Array or string' },
    ],
    returnType: 'T',
    examples: [
      "ctx.first(ctx.body('GetItems').value)",
    ],
  },
  {
    name: 'last',
    category: 'Collection',
    description: 'Get the last element of an array or the last character of a string. Emits `@last(...)`.',
    parameters: [
      { name: 'collection', type: 'any[] | string', description: 'Array or string' },
    ],
    returnType: 'T',
    examples: [
      "ctx.last(ctx.variables('processedIds'))",
    ],
  },
  {
    name: 'skip',
    category: 'Collection',
    description: 'Skip the first count elements of an array. Emits `@skip(...)`.',
    parameters: [
      { name: 'collection', type: 'any[]', description: 'Array to skip from' },
      { name: 'count', type: 'number', description: 'Number of elements to skip' },
    ],
    returnType: 'T[]',
    examples: [
      "ctx.skip(ctx.body('GetItems').value, 5)",
    ],
  },
  {
    name: 'take',
    category: 'Collection',
    description: 'Take the first count elements of an array or characters of a string. Emits `@take(...)`.',
    parameters: [
      { name: 'collection', type: 'any[] | string', description: 'Array or string' },
      { name: 'count', type: 'number', description: 'Number of elements to take' },
    ],
    returnType: 'T',
    examples: [
      "ctx.take(ctx.body('GetItems').value, 10)",
    ],
  },
  {
    name: 'empty',
    category: 'Collection',
    description: 'Check whether an array, string, or object is empty. Emits `@empty(...)`.',
    parameters: [
      { name: 'collection', type: 'any[] | string | object', description: 'Collection to check' },
    ],
    returnType: 'boolean',
    examples: [
      "if (ctx.empty(ctx.variables('errors'))) { ... }",
    ],
  },
  {
    name: 'length',
    category: 'Collection',
    description: 'Get the number of elements in an array or characters in a string. Emits `@length(...)`. In the DSL you can also use the `.length` property directly.',
    parameters: [
      { name: 'collection', type: 'any[] | string', description: 'Array or string' },
    ],
    returnType: 'number',
    examples: [
      "ctx.length(ctx.variables('processedIds'))",
    ],
  },

  {
    name: 'contains',
    category: 'Collection',
    description: 'Check whether a collection contains a value (string contains substring, array contains item, object contains key). Emits `@contains(...)`.',
    parameters: [
      { name: 'collection', type: 'string | any[] | object', description: 'Collection to search' },
      { name: 'value', type: 'any', description: 'Value to find' },
    ],
    returnType: 'boolean',
    examples: ["if (ctx.contains(ctx.variables('tags'), 'urgent')) { ... }"],
  },
  {
    name: 'chunk',
    category: 'Collection',
    description: 'Split an array or string into chunks of the given length. Emits `@chunk(...)`.',
    parameters: [
      { name: 'collection', type: 'any[] | string', description: 'Array or string to split' },
      { name: 'length', type: 'number', description: 'Chunk size' },
    ],
    returnType: 'T[][]',
    examples: ["ctx.chunk(ctx.body('GetItems').value, 100)"],
  },
  {
    name: 'reverse',
    category: 'Collection',
    description: 'Reverse the order of items in an array. Emits `@reverse(...)`.',
    parameters: [
      { name: 'collection', type: 'any[]', description: 'Array to reverse' },
    ],
    returnType: 'T[]',
    examples: ["ctx.reverse(ctx.variables('items'))"],
  },
  {
    name: 'sort',
    category: 'Collection',
    description: 'Sort an array, optionally by an object property. Emits `@sort(...)`.',
    parameters: [
      { name: 'collection', type: 'any[]', description: 'Array to sort' },
      { name: 'sortBy', type: 'string', description: 'Property to sort by', optional: true },
    ],
    returnType: 'T[]',
    examples: ["ctx.sort(ctx.body('GetItems').value, 'createdOn')"],
  },

  // ============================================
  // String Functions
  // ============================================
  {
    name: 'concat',
    category: 'String',
    description: 'Concatenate values into a single string. Emits `@concat(...)`.',
    parameters: [
      { name: '...values', type: 'any[]', description: 'Values to concatenate' },
    ],
    returnType: 'string',
    examples: ["ctx.concat('Hello, ', name, '!')"],
  },
  {
    name: 'indexOf',
    category: 'String',
    description: 'Index of the first occurrence of searchText (case-insensitive), or -1. Emits `@indexOf(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'String to search in' },
      { name: 'searchText', type: 'string', description: 'Substring to find' },
    ],
    returnType: 'number',
    examples: ["ctx.indexOf(email, '@')"],
  },
  {
    name: 'lastIndexOf',
    category: 'String',
    description: 'Index of the last occurrence of searchText (case-insensitive), or -1. Emits `@lastIndexOf(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'String to search in' },
      { name: 'searchText', type: 'string', description: 'Substring to find' },
    ],
    returnType: 'number',
    examples: ["ctx.lastIndexOf(path, '/')"],
  },
  {
    name: 'nthIndexOf',
    category: 'String',
    description: 'Index of the nth occurrence of searchText, or -1. Emits `@nthIndexOf(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'String to search in' },
      { name: 'searchText', type: 'string', description: 'Substring to find' },
      { name: 'occurrence', type: 'number', description: 'Which occurrence (1-based)' },
    ],
    returnType: 'number',
    examples: ["ctx.nthIndexOf(csvLine, ',', 2)"],
  },
  {
    name: 'substring',
    category: 'String',
    description: 'Extract a substring by start index and length (NOT end index). Emits `@substring(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'Source string' },
      { name: 'startIndex', type: 'number', description: 'Start position (0-based)' },
      { name: 'length', type: 'number', description: 'Number of characters', optional: true },
    ],
    returnType: 'string',
    examples: ["ctx.substring(sku, 0, 3)"],
  },
  {
    name: 'replace',
    category: 'String',
    description: 'Replace all occurrences of oldText with newText (case-sensitive). Emits `@replace(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'Source string' },
      { name: 'oldText', type: 'string', description: 'Text to replace' },
      { name: 'newText', type: 'string', description: 'Replacement text' },
    ],
    returnType: 'string',
    examples: ["ctx.replace(title, ' ', '_')"],
  },
  {
    name: 'toLower',
    category: 'String',
    description: 'Convert to lowercase. Emits `@toLower(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'String to convert' },
    ],
    returnType: 'string',
    examples: ["ctx.toLower(email)"],
  },
  {
    name: 'toUpper',
    category: 'String',
    description: 'Convert to uppercase. Emits `@toUpper(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'String to convert' },
    ],
    returnType: 'string',
    examples: ["ctx.toUpper(countryCode)"],
  },
  {
    name: 'trim',
    category: 'String',
    description: 'Remove leading and trailing whitespace. Emits `@trim(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'String to trim' },
    ],
    returnType: 'string',
    examples: ["ctx.trim(userInput)"],
  },
  {
    name: 'split',
    category: 'String',
    description: 'Split a string into an array on a delimiter. Emits `@split(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'String to split' },
      { name: 'delimiter', type: 'string', description: 'Delimiter' },
    ],
    returnType: 'string[]',
    examples: ["ctx.split(csvLine, ',')"],
  },
  {
    name: 'startsWith',
    category: 'String',
    description: 'Whether the string starts with searchText (case-insensitive). Emits `@startsWith(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'String to check' },
      { name: 'searchText', type: 'string', description: 'Prefix to test' },
    ],
    returnType: 'boolean',
    examples: ["ctx.startsWith(url, 'https://')"],
  },
  {
    name: 'endsWith',
    category: 'String',
    description: 'Whether the string ends with searchText (case-insensitive). Emits `@endsWith(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'String to check' },
      { name: 'searchText', type: 'string', description: 'Suffix to test' },
    ],
    returnType: 'boolean',
    examples: ["ctx.endsWith(fileName, '.pdf')"],
  },
  {
    name: 'slice',
    category: 'String',
    description: 'Extract a substring by start index and end index (exclusive). Emits `@slice(...)`.',
    parameters: [
      { name: 'text', type: 'string', description: 'Source string' },
      { name: 'startIndex', type: 'number', description: 'Start position (0-based)' },
      { name: 'endIndex', type: 'number', description: 'End position (exclusive)', optional: true },
    ],
    returnType: 'string',
    examples: ["ctx.slice(isoDate, 0, 10)"],
  },

  // ============================================
  // Math Functions
  // ============================================
  {
    name: 'add',
    category: 'Math',
    description: 'Add two numbers. Emits `@add(...)`.',
    parameters: [
      { name: 'summand1', type: 'number', description: 'First number' },
      { name: 'summand2', type: 'number', description: 'Second number' },
    ],
    returnType: 'number',
    examples: ["ctx.add(subtotal, shipping)"],
  },
  {
    name: 'sub',
    category: 'Math',
    description: 'Subtract the second number from the first. Emits `@sub(...)`.',
    parameters: [
      { name: 'minuend', type: 'number', description: 'Number to subtract from' },
      { name: 'subtrahend', type: 'number', description: 'Number to subtract' },
    ],
    returnType: 'number',
    examples: ["ctx.sub(total, discount)"],
  },
  {
    name: 'mul',
    category: 'Math',
    description: 'Multiply two numbers. Emits `@mul(...)`.',
    parameters: [
      { name: 'multiplicand1', type: 'number', description: 'First number' },
      { name: 'multiplicand2', type: 'number', description: 'Second number' },
    ],
    returnType: 'number',
    examples: ["ctx.mul(quantity, unitPrice)"],
  },
  {
    name: 'div',
    category: 'Math',
    description: 'Divide the first number by the second. Emits `@div(...)`.',
    parameters: [
      { name: 'dividend', type: 'number', description: 'Number to divide' },
      { name: 'divisor', type: 'number', description: 'Number to divide by' },
    ],
    returnType: 'number',
    examples: ["ctx.div(total, count)"],
  },
  {
    name: 'mod',
    category: 'Math',
    description: 'Remainder after dividing the first number by the second. Emits `@mod(...)`.',
    parameters: [
      { name: 'dividend', type: 'number', description: 'Number to divide' },
      { name: 'divisor', type: 'number', description: 'Number to divide by' },
    ],
    returnType: 'number',
    examples: ["ctx.mod(index, 2)"],
  },
  {
    name: 'min',
    category: 'Math',
    description: 'Lowest value among the arguments (numbers or a single array of numbers). Emits `@min(...)`.',
    parameters: [
      { name: '...numbers', type: 'number[]', description: 'Numbers to compare' },
    ],
    returnType: 'number',
    examples: ["ctx.min(a, b, c)"],
  },
  {
    name: 'max',
    category: 'Math',
    description: 'Highest value among the arguments (numbers or a single array of numbers). Emits `@max(...)`.',
    parameters: [
      { name: '...numbers', type: 'number[]', description: 'Numbers to compare' },
    ],
    returnType: 'number',
    examples: ["ctx.max(a, b, c)"],
  },
  {
    name: 'abs',
    category: 'Math',
    description: 'Absolute value. Emits `@abs(...)`.',
    parameters: [
      { name: 'value', type: 'number', description: 'Number' },
    ],
    returnType: 'number',
    examples: ["ctx.abs(delta)"],
  },
  {
    name: 'ceil',
    category: 'Math',
    description: 'Round up to the nearest integer. Emits `@ceil(...)`.',
    parameters: [
      { name: 'value', type: 'number', description: 'Number' },
    ],
    returnType: 'number',
    examples: ["ctx.ceil(pages)"],
  },
  {
    name: 'floor',
    category: 'Math',
    description: 'Round down to the nearest integer. Emits `@floor(...)`.',
    parameters: [
      { name: 'value', type: 'number', description: 'Number' },
    ],
    returnType: 'number',
    examples: ["ctx.floor(ratio)"],
  },
  {
    name: 'round',
    category: 'Math',
    description: 'Round to the given number of decimal places. Emits `@round(...)`.',
    parameters: [
      { name: 'value', type: 'number', description: 'Number to round' },
      { name: 'digits', type: 'number', description: 'Decimal places', optional: true },
    ],
    returnType: 'number',
    examples: ["ctx.round(price, 2)"],
  },
  {
    name: 'rand',
    category: 'Math',
    description: 'Random integer in the range [minValue, maxValue). Emits `@rand(...)`.',
    parameters: [
      { name: 'minValue', type: 'number', description: 'Lowest possible value (inclusive)' },
      { name: 'maxValue', type: 'number', description: 'Upper bound (exclusive)' },
    ],
    returnType: 'number',
    examples: ["ctx.rand(1, 100)"],
  },
  {
    name: 'int',
    category: 'Math',
    description: 'Convert a value to an integer. Emits `@int(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to convert' },
    ],
    returnType: 'number',
    examples: ["ctx.int(ctx.triggerBody()?.['count'])"],
  },
  {
    name: 'float',
    category: 'Math',
    description: 'Convert a value to a floating-point number. Emits `@float(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to convert' },
    ],
    returnType: 'number',
    examples: ["ctx.float(priceText)"],
  },
  {
    name: 'decimal',
    category: 'Math',
    description: 'Convert a value to a decimal number. Emits `@decimal(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to convert' },
    ],
    returnType: 'number',
    examples: ["ctx.decimal(amountText)"],
  },
  {
    name: 'isFloat',
    category: 'Math',
    description: 'Whether the value is a floating-point number (optionally locale-aware). Emits `@isFloat(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to test' },
      { name: 'locale', type: 'string', description: 'Locale for parsing', optional: true },
    ],
    returnType: 'boolean',
    examples: ["ctx.isFloat(input)"],
  },
  {
    name: 'isInt',
    category: 'Math',
    description: 'Whether the value is an integer. Emits `@isInt(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to test' },
    ],
    returnType: 'boolean',
    examples: ["ctx.isInt(input)"],
  },

  // ============================================
  // Comparison & Logical Functions
  // ============================================
  {
    name: 'equals',
    category: 'Logical',
    description: 'Whether two values are equal. Emits `@equals(...)`.',
    parameters: [
      { name: 'object1', type: 'any', description: 'First value' },
      { name: 'object2', type: 'any', description: 'Second value' },
    ],
    returnType: 'boolean',
    examples: ["if (ctx.equals(status, 'active')) { ... }"],
  },
  {
    name: 'greater',
    category: 'Logical',
    description: 'Whether the first value is greater than the second. Emits `@greater(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to compare' },
      { name: 'compareTo', type: 'any', description: 'Value to compare against' },
    ],
    returnType: 'boolean',
    examples: ["if (ctx.greater(total, 1000)) { ... }"],
  },
  {
    name: 'less',
    category: 'Logical',
    description: 'Whether the first value is less than the second. Emits `@less(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to compare' },
      { name: 'compareTo', type: 'any', description: 'Value to compare against' },
    ],
    returnType: 'boolean',
    examples: ["if (ctx.less(stock, 10)) { ... }"],
  },
  {
    name: 'greaterOrEquals',
    category: 'Logical',
    description: 'Whether the first value is greater than or equal to the second. Emits `@greaterOrEquals(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to compare' },
      { name: 'compareTo', type: 'any', description: 'Value to compare against' },
    ],
    returnType: 'boolean',
    examples: ["if (ctx.greaterOrEquals(score, 80)) { ... }"],
  },
  {
    name: 'lessOrEquals',
    category: 'Logical',
    description: 'Whether the first value is less than or equal to the second. Emits `@lessOrEquals(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to compare' },
      { name: 'compareTo', type: 'any', description: 'Value to compare against' },
    ],
    returnType: 'boolean',
    examples: ["if (ctx.lessOrEquals(age, 65)) { ... }"],
  },
  {
    name: 'and',
    category: 'Logical',
    description: 'Whether all expressions are true. Emits `@and(...)`.',
    parameters: [
      { name: '...expressions', type: 'boolean[]', description: 'Conditions to combine' },
    ],
    returnType: 'boolean',
    examples: ["ctx.and(isActive, hasLicense)"],
  },
  {
    name: 'or',
    category: 'Logical',
    description: 'Whether at least one expression is true. Emits `@or(...)`.',
    parameters: [
      { name: '...expressions', type: 'boolean[]', description: 'Conditions to combine' },
    ],
    returnType: 'boolean',
    examples: ["ctx.or(isAdmin, isOwner)"],
  },
  {
    name: 'not',
    category: 'Logical',
    description: 'Negate a boolean expression. Emits `@not(...)`.',
    parameters: [
      { name: 'expression', type: 'boolean', description: 'Condition to negate' },
    ],
    returnType: 'boolean',
    examples: ["ctx.not(ctx.empty(items))"],
  },
  {
    name: 'if',
    category: 'Logical',
    description: 'Return one of two values based on a condition. Emits `@if(...)`.',
    parameters: [
      { name: 'expression', type: 'boolean', description: 'Condition' },
      { name: 'valueIfTrue', type: 'T', description: 'Value when true' },
      { name: 'valueIfFalse', type: 'T', description: 'Value when false' },
    ],
    returnType: 'T',
    examples: ["ctx.if(ctx.greater(total, 100), 'large', 'small')"],
  },
  {
    name: 'coalesce',
    category: 'Logical',
    description: 'First non-null value among the arguments. Emits `@coalesce(...)`.',
    parameters: [
      { name: '...values', type: 'any[]', description: 'Values to check in order' },
    ],
    returnType: 'T',
    examples: ["ctx.coalesce(nickname, fullName, 'Unknown')"],
  },

  // ============================================
  // Conversion & Encoding Functions
  // ============================================
  {
    name: 'json',
    category: 'Conversion',
    description: 'Parse a JSON string (or XML) into an object. Emits `@json(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'JSON string or XML' },
    ],
    returnType: 'T',
    examples: ["ctx.json(ctx.body('HttpRequest'))"],
  },
  {
    name: 'string',
    category: 'Conversion',
    description: 'Convert a value to a string. Emits `@string(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to convert' },
    ],
    returnType: 'string',
    examples: ["ctx.string(orderId)"],
  },
  {
    name: 'array',
    category: 'Conversion',
    description: 'Wrap a value in an array. Emits `@array(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to wrap' },
    ],
    returnType: 'T[]',
    examples: ["ctx.array(singleItem)"],
  },
  {
    name: 'bool',
    category: 'Conversion',
    description: 'Convert a value to a boolean. Emits `@bool(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'Value to convert' },
    ],
    returnType: 'boolean',
    examples: ["ctx.bool(flagText)"],
  },
  {
    name: 'base64',
    category: 'Conversion',
    description: 'Base64-encode a string. Emits `@base64(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'String to encode' },
    ],
    returnType: 'string',
    examples: ["ctx.base64(payload)"],
  },
  {
    name: 'base64ToString',
    category: 'Conversion',
    description: 'Decode a base64 string to text. Emits `@base64ToString(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'Base64 string to decode' },
    ],
    returnType: 'string',
    examples: ["ctx.base64ToString(encoded)"],
  },
  {
    name: 'base64ToBinary',
    category: 'Conversion',
    description: 'Convert a base64 string to binary content. Emits `@base64ToBinary(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'Base64 string' },
    ],
    returnType: 'any',
    examples: ["ctx.base64ToBinary(fileContent)"],
  },
  {
    name: 'binary',
    category: 'Conversion',
    description: 'Convert a string to binary content. Emits `@binary(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'String to convert' },
    ],
    returnType: 'any',
    examples: ["ctx.binary(text)"],
  },
  {
    name: 'dataUri',
    category: 'Conversion',
    description: 'Convert a string to a data URI. Emits `@dataUri(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'String to convert' },
    ],
    returnType: 'string',
    examples: ["ctx.dataUri(svgText)"],
  },
  {
    name: 'dataUriToBinary',
    category: 'Conversion',
    description: 'Convert a data URI to binary content. Emits `@dataUriToBinary(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'Data URI' },
    ],
    returnType: 'any',
    examples: ["ctx.dataUriToBinary(uri)"],
  },
  {
    name: 'dataUriToString',
    category: 'Conversion',
    description: 'Convert a data URI to a string. Emits `@dataUriToString(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'Data URI' },
    ],
    returnType: 'string',
    examples: ["ctx.dataUriToString(uri)"],
  },
  {
    name: 'decodeDataUri',
    category: 'Conversion',
    description: 'Decode the data portion of a data URI. Emits `@decodeDataUri(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'Data URI' },
    ],
    returnType: 'any',
    examples: ["ctx.decodeDataUri(uri)"],
  },
  {
    name: 'uriComponent',
    category: 'Conversion',
    description: 'URI-encode a string. Emits `@uriComponent(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'String to encode' },
    ],
    returnType: 'string',
    examples: ["ctx.uriComponent(searchTerm)"],
  },
  {
    name: 'uriComponentToString',
    category: 'Conversion',
    description: 'Decode a URI-encoded string. Emits `@uriComponentToString(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'URI-encoded string' },
    ],
    returnType: 'string',
    examples: ["ctx.uriComponentToString(encoded)"],
  },
  {
    name: 'uriComponentToBinary',
    category: 'Conversion',
    description: 'Convert a URI-encoded string to binary content. Emits `@uriComponentToBinary(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'URI-encoded string' },
    ],
    returnType: 'any',
    examples: ["ctx.uriComponentToBinary(encoded)"],
  },
  {
    name: 'decodeUriComponent',
    category: 'Conversion',
    description: 'Decode a URI-encoded string. Prefer uriComponentToString(). Emits `@decodeUriComponent(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'URI-encoded string' },
    ],
    returnType: 'string',
    examples: ["ctx.decodeUriComponent(encoded)"],
  },
  {
    name: 'decodeBase64',
    category: 'Conversion',
    description: 'Decode a base64 string to text. Prefer base64ToString(). Emits `@decodeBase64(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'Base64 string' },
    ],
    returnType: 'string',
    examples: ["ctx.decodeBase64(encoded)"],
  },
  {
    name: 'encodeUriComponent',
    category: 'Conversion',
    description: 'URI-encode a string. Prefer uriComponent(). Emits `@encodeUriComponent(...)`.',
    parameters: [
      { name: 'value', type: 'string', description: 'String to encode' },
    ],
    returnType: 'string',
    examples: ["ctx.encodeUriComponent(searchTerm)"],
  },
  {
    name: 'xml',
    category: 'Conversion',
    description: 'Convert a string or JSON object to XML. Emits `@xml(...)`.',
    parameters: [
      { name: 'value', type: 'any', description: 'String or JSON object' },
    ],
    returnType: 'any',
    examples: ["ctx.xml(ctx.json(payload))"],
  },
  {
    name: 'xpath',
    category: 'Conversion',
    description: 'Evaluate an XPath expression against XML content. Emits `@xpath(...)`.',
    parameters: [
      { name: 'xml', type: 'any', description: 'XML content' },
      { name: 'xpath', type: 'string', description: 'XPath expression' },
    ],
    returnType: 'any',
    examples: ["ctx.xpath(doc, '//item/name')"],
  },

  // ============================================
  // Object Functions
  // ============================================
  {
    name: 'setProperty',
    category: 'Object',
    description: 'Return a copy of the object with the property set (added or updated). Emits `@setProperty(...)`.',
    parameters: [
      { name: 'object', type: 'object', description: 'Source object' },
      { name: 'property', type: 'string', description: 'Property name' },
      { name: 'value', type: 'any', description: 'New value' },
    ],
    returnType: 'T',
    examples: ["ctx.setProperty(order, 'status', 'shipped')"],
  },
  {
    name: 'addProperty',
    category: 'Object',
    description: 'Return a copy of the object with the property added. Emits `@addProperty(...)`.',
    parameters: [
      { name: 'object', type: 'object', description: 'Source object' },
      { name: 'property', type: 'string', description: 'Property name' },
      { name: 'value', type: 'any', description: 'Value to add' },
    ],
    returnType: 'T',
    examples: ["ctx.addProperty(user, 'verified', true)"],
  },
  {
    name: 'removeProperty',
    category: 'Object',
    description: 'Return a copy of the object with the property removed. Emits `@removeProperty(...)`.',
    parameters: [
      { name: 'object', type: 'object', description: 'Source object' },
      { name: 'property', type: 'string', description: 'Property to remove' },
    ],
    returnType: 'T',
    examples: ["ctx.removeProperty(record, 'internalId')"],
  },

  // ============================================
  // URI Parsing Functions
  // ============================================
  {
    name: 'uriHost',
    category: 'Uri',
    description: 'Host portion of a URI. Emits `@uriHost(...)`.',
    parameters: [
      { name: 'uri', type: 'string', description: 'URI to parse' },
    ],
    returnType: 'string',
    examples: ["ctx.uriHost('https://example.com/path')"],
  },
  {
    name: 'uriPath',
    category: 'Uri',
    description: 'Path portion of a URI. Emits `@uriPath(...)`.',
    parameters: [
      { name: 'uri', type: 'string', description: 'URI to parse' },
    ],
    returnType: 'string',
    examples: ["ctx.uriPath(requestUrl)"],
  },
  {
    name: 'uriPathAndQuery',
    category: 'Uri',
    description: 'Path and query portion of a URI. Emits `@uriPathAndQuery(...)`.',
    parameters: [
      { name: 'uri', type: 'string', description: 'URI to parse' },
    ],
    returnType: 'string',
    examples: ["ctx.uriPathAndQuery(requestUrl)"],
  },
  {
    name: 'uriPort',
    category: 'Uri',
    description: 'Port number of a URI. Emits `@uriPort(...)`.',
    parameters: [
      { name: 'uri', type: 'string', description: 'URI to parse' },
    ],
    returnType: 'number',
    examples: ["ctx.uriPort(endpoint)"],
  },
  {
    name: 'uriQuery',
    category: 'Uri',
    description: 'Query string portion of a URI. Emits `@uriQuery(...)`.',
    parameters: [
      { name: 'uri', type: 'string', description: 'URI to parse' },
    ],
    returnType: 'string',
    examples: ["ctx.uriQuery(requestUrl)"],
  },
  {
    name: 'uriScheme',
    category: 'Uri',
    description: 'Scheme (protocol) of a URI. Emits `@uriScheme(...)`.',
    parameters: [
      { name: 'uri', type: 'string', description: 'URI to parse' },
    ],
    returnType: 'string',
    examples: ["ctx.uriScheme(requestUrl)"],
  },

  // ============================================
  // Workflow & Form Data Functions
  // ============================================
  {
    name: 'result',
    category: 'Workflow',
    description: 'Results of all actions inside a scope (useful in error handling). Emits `@result(...)`.',
    parameters: [
      { name: 'scopeName', type: 'string', description: 'Name of the scope action' },
    ],
    returnType: 'any[]',
    examples: ["ctx.result('TryScope')"],
  },
  {
    name: 'action',
    category: 'Workflow',
    description: 'Details of the current action (inside do-until or error handlers). Emits `@action()`.',
    parameters: [],
    returnType: 'T',
    examples: ["ctx.action().outputs"],
  },
  {
    name: 'actionBody',
    category: 'Workflow',
    description: 'Body of a previous action. Prefer body(). Emits `@actionBody(...)`.',
    parameters: [
      { name: 'actionName', type: 'string', description: 'Name of the action' },
    ],
    returnType: 'T',
    examples: ["ctx.actionBody('GetUser')"],
  },
  {
    name: 'iterationIndexes',
    category: 'Workflow',
    description: 'Current iteration index of a do-until loop. Emits `@iterationIndexes(...)`.',
    parameters: [
      { name: 'loopName', type: 'string', description: 'Name of the do-until loop' },
    ],
    returnType: 'number',
    examples: ["ctx.iterationIndexes('RetryLoop')"],
  },
  {
    name: 'listCallbackUrl',
    category: 'Workflow',
    description: "Callback URL of the flow's HTTP trigger. Emits `@listCallbackUrl()`.",
    parameters: [],
    returnType: 'string',
    examples: ["ctx.listCallbackUrl()"],
  },
  {
    name: 'formDataValue',
    category: 'Workflow',
    description: "Value of a form-data key in an action's output. Emits `@formDataValue(...)`.",
    parameters: [
      { name: 'actionName', type: 'string', description: 'Name of the action' },
      { name: 'key', type: 'string', description: 'Form-data key' },
    ],
    returnType: 'any',
    examples: ["ctx.formDataValue('UploadForm', 'email')"],
  },
  {
    name: 'formDataMultiValues',
    category: 'Workflow',
    description: "All values of a form-data key in an action's output. Emits `@formDataMultiValues(...)`.",
    parameters: [
      { name: 'actionName', type: 'string', description: 'Name of the action' },
      { name: 'key', type: 'string', description: 'Form-data key' },
    ],
    returnType: 'any[]',
    examples: ["ctx.formDataMultiValues('UploadForm', 'tags')"],
  },
  {
    name: 'multipartBody',
    category: 'Workflow',
    description: "Body of a part in an action's multipart output. Emits `@multipartBody(...)`.",
    parameters: [
      { name: 'actionName', type: 'string', description: 'Name of the action' },
      { name: 'index', type: 'number', description: 'Part index (0-based)' },
    ],
    returnType: 'any',
    examples: ["ctx.multipartBody('SendBatch', 0)"],
  },
  {
    name: 'triggerFormDataValue',
    category: 'Workflow',
    description: 'Value of a form-data key in the trigger output. Emits `@triggerFormDataValue(...)`.',
    parameters: [
      { name: 'key', type: 'string', description: 'Form-data key' },
    ],
    returnType: 'any',
    examples: ["ctx.triggerFormDataValue('email')"],
  },
  {
    name: 'triggerFormDataMultiValues',
    category: 'Workflow',
    description: 'All values of a form-data key in the trigger output. Emits `@triggerFormDataMultiValues(...)`.',
    parameters: [
      { name: 'key', type: 'string', description: 'Form-data key' },
    ],
    returnType: 'any[]',
    examples: ["ctx.triggerFormDataMultiValues('tags')"],
  },
  {
    name: 'triggerMultipartBody',
    category: 'Workflow',
    description: "Body of a part in the trigger's multipart output. Emits `@triggerMultipartBody(...)`.",
    parameters: [
      { name: 'index', type: 'number', description: 'Part index (0-based)' },
    ],
    returnType: 'any',
    examples: ["ctx.triggerMultipartBody(0)"],
  },

  // ============================================
  // Additional Date/Time Functions
  // ============================================
  {
    name: 'parseDateTime',
    category: 'DateTime',
    description: 'Parse a date/time string with optional locale and format.',
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Date/time string to parse' },
      { name: 'locale', type: 'string', description: 'Locale for parsing (e.g., "de-DE")', optional: true },
      { name: 'format', type: 'string', description: 'Format string', optional: true },
    ],
    returnType: 'string',
    examples: ["ctx.parseDateTime('23.07.2026', 'de-DE')"],
  },
  {
    name: 'addToTime',
    category: 'DateTime',
    description: "Add an interval to a timestamp (unit: 'Second', 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year'). Emits `@addToTime(...)`.",
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Starting timestamp' },
      { name: 'interval', type: 'number', description: 'Number of units to add' },
      { name: 'timeUnit', type: 'string', description: "Unit ('Day', 'Hour', ...)" },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: ["ctx.addToTime(ctx.utcNow(), 3, 'Day')"],
  },
  {
    name: 'subtractFromTime',
    category: 'DateTime',
    description: "Subtract an interval from a timestamp (unit: 'Second', 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year'). Emits `@subtractFromTime(...)`.",
    parameters: [
      { name: 'timestamp', type: 'string', description: 'Starting timestamp' },
      { name: 'interval', type: 'number', description: 'Number of units to subtract' },
      { name: 'timeUnit', type: 'string', description: "Unit ('Day', 'Hour', ...)" },
      { name: 'format', type: 'string', description: 'Output format', optional: true },
    ],
    returnType: 'string',
    examples: ["ctx.subtractFromTime(ctx.utcNow(), 7, 'Day')"],
  },
  {
    name: 'dateDifference',
    category: 'DateTime',
    description: 'Difference between two timestamps as a timespan string (e.g. "1.00:00:00"). Emits `@dateDifference(...)`.',
    parameters: [
      { name: 'startDate', type: 'string', description: 'Start timestamp' },
      { name: 'endDate', type: 'string', description: 'End timestamp' },
    ],
    returnType: 'string',
    examples: ["ctx.dateDifference(createdOn, ctx.utcNow())"],
  },

  // ============================================
  // Expression Literal Helpers (DSL-specific)
  // ============================================
  {
    name: 'braced',
    category: 'Expression',
    description: 'Force string-interpolation output: wraps the expression as `@{...}` (string coercion) instead of `@...` (type-preserving). Only needed when you explicitly want a string.',
    parameters: [
      { name: 'expression', type: 'any', description: 'Expression to wrap' },
    ],
    returnType: 'string',
    examples: ["await ctx.compose('Msg', ctx.braced(ctx.concat('Total: ', total)))"],
  },
  {
    name: 'atTrue',
    category: 'Expression',
    description: 'Emit the literal expression `@true` (for parity with existing flows).',
    parameters: [],
    returnType: 'boolean',
    examples: ["ctx.atTrue()"],
  },
  {
    name: 'atFalse',
    category: 'Expression',
    description: 'Emit the literal expression `@false` (for parity with existing flows).',
    parameters: [],
    returnType: 'boolean',
    examples: ["ctx.atFalse()"],
  },
  {
    name: 'atNumber',
    category: 'Expression',
    description: 'Emit a literal number expression like `@0` (for parity with existing flows).',
    parameters: [
      { name: 'value', type: 'number', description: 'Number literal' },
    ],
    returnType: 'number',
    examples: ["ctx.atNumber(0)"],
  },
  {
    name: 'atString',
    category: 'Expression',
    description: "Emit a quoted string-literal expression like `@'text'` (for parity with existing flows).",
    parameters: [
      { name: 'value', type: 'string', description: 'String literal' },
    ],
    returnType: 'string',
    examples: ["ctx.atString('fixed')"],
  },
  {
    name: 'null',
    category: 'Expression',
    description: 'Emit the literal expression `@null` (for parity with existing flows).',
    parameters: [],
    returnType: 'null',
    examples: ["ctx.null()"],
  },

  // ============================================
  // Utility Functions
  // ============================================
  {
    name: 'guid',
    category: 'Utility',
    description: 'Generate a new GUID.',
    parameters: [],
    returnType: 'string',
    examples: [
      'ctx.guid()',
    ],
  },
  {
    name: 'formatNumber',
    category: 'Utility',
    description: 'Format a number as a string using a .NET numeric format string and optional locale.',
    parameters: [
      { name: 'number', type: 'number', description: 'The number to format' },
      { name: 'format', type: 'string', description: 'Format string (e.g., "C2", "P2", "N0", "F2", "0.00")' },
      { name: 'locale', type: 'string', description: 'Locale (e.g., "en-US", "de-DE")', optional: true },
    ],
    returnType: 'string',
    examples: [
      "ctx.formatNumber(1234.5, 'C2', 'en-US')",
      "ctx.formatNumber(0.123, 'P2', 'en-US')",
    ],
  },
];

/**
 * Get methods by category.
 */
export function getMethodsByCategory(category: string): MethodSignature[] {
  return flowContextMethods.filter((m) => m.category === category);
}

/**
 * Get all categories.
 */
export function getCategories(): string[] {
  const categories = new Set(flowContextMethods.map((m) => m.category).filter((c): c is string => c !== undefined));
  return Array.from(categories);
}

/**
 * Find a method by name.
 */
export function findMethod(name: string): MethodSignature | undefined {
  return flowContextMethods.find((m) => m.name === name);
}
