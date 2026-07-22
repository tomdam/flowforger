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
