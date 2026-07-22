import type { FlowIR, ActionNode, TriggerNode, RecurrenceTriggerNode, Node, ConnectionReference, ChildFlowDefinition } from '@flowforger/ir';

// Operation ID mapping: FlowForger IR → Power Automate cloud
// Some Power Automate connectors use different operationIds than the names
// FlowForger exposes through the DSL. This map performs the rewrite per
// connector at emit time so the produced clientdata.json activates cleanly.
const IR_TO_PA_OPERATIONS: Record<string, Record<string, string>> = {
  sharepoint: {
    'CreateItem': 'PostItem',
    'GetItemById': 'GetItem',
    'UpdateItem': 'PatchItem',
  },
  office365: {
    // Power Automate uses an underscore before the version suffix.
    'ExportEmailV2': 'ExportEmail_V2',
  },
};

function mapIrOperationToPa(connector: string, operation: string): string {
  return IR_TO_PA_OPERATIONS[connector]?.[operation] ?? operation;
}

// Browser-compatible UUID generation
function randomUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Convert @createArray(...) expressions with only primitive values back to literal arrays.
 * This is needed for parity with Logic Apps JSON which uses literal arrays for simple cases.
 *
 * Examples:
 * - "@createArray(1, 2)" -> [1, 2]
 * - "@createArray('a', 'b')" -> ["a", "b"]
 * - "@createArray(body('X'))" -> "@createArray(body('X'))" (has expression, keep as-is)
 * - "@body('items')" -> "@body('items')" (not createArray, keep as-is)
 */
function convertCreateArrayToLiteralIfPossible(expr: string): string | any[] {
  if (typeof expr !== 'string') {
    return expr;
  }

  // Check if it's a @createArray(...) expression
  const match = expr.match(/^@createArray\((.*)\)$/);
  if (!match) {
    return expr;
  }

  const argsStr = match[1].trim();
  if (!argsStr) {
    return []; // Empty array
  }

  // Parse the arguments - need to handle nested parentheses and strings
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let current = '';

  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];

    if (inString) {
      current += char;
      if (char === stringChar && argsStr[i - 1] !== '\\') {
        inString = false;
      }
    } else if (char === "'" || char === '"') {
      current += char;
      inString = true;
      stringChar = char;
    } else if (char === '(') {
      current += char;
      depth++;
    } else if (char === ')') {
      current += char;
      depth--;
    } else if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    args.push(current.trim());
  }

  // Check if all arguments are primitive literals (no expressions)
  const primitives: any[] = [];
  for (const arg of args) {
    // Number
    if (/^-?\d+(\.\d+)?$/.test(arg)) {
      primitives.push(Number(arg));
      continue;
    }
    // Boolean
    if (arg === 'true') {
      primitives.push(true);
      continue;
    }
    if (arg === 'false') {
      primitives.push(false);
      continue;
    }
    // Null
    if (arg === 'null') {
      primitives.push(null);
      continue;
    }
    // String literal (single or double quoted)
    if ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"'))) {
      const content = arg.slice(1, -1);
      // Unescape the string (PA uses '' for escaped single quote inside single-quoted strings)
      const unescaped = arg.startsWith("'")
        ? content.replace(/''/g, "'")
        : content.replace(/\\"/g, '"');
      primitives.push(unescaped);
      continue;
    }
    // Contains function call or expression - can't convert to literal array
    if (arg.includes('(') || arg.includes('@')) {
      return expr;
    }
    // Unknown - keep as expression
    return expr;
  }

  // All arguments are primitives, return as literal array
  return primitives;
}

/**
 * Recursively escape literal @ at the start of string values to @@ for Logic Apps JSON.
 * In Power Automate, @@ produces a literal @ character.
 * Only escapes literal @ values, not PA expressions (which start with @functionName or @{).
 */
function escapeAtSymbol(value: any): any {
  if (typeof value === 'string') {
    // Only escape if it's a literal @ value, not a PA expression
    // PA expressions: @functionName(...), @{...}, @true, @false, @null, @number
    // PA also allows whitespace after @ (e.g. multiline expressions like "@\n  if(...)")
    // Literal @: just "@" or "@" followed by non-alphanumeric/non-{ characters
    // Already escaped: @@ should NOT be escaped again
    if (value.startsWith('@')) {
      const nextChar = value.charAt(1);
      if (nextChar === '@') {
        return value;
      }
      if (value === '@true' || value === '@false' || value === '@null' || /^@-?\d/.test(value)) {
        return value;
      }
      // PA expressions allow whitespace between @ and the expression body
      const firstNonWs = value.slice(1).replace(/^\s+/, '').charAt(0);
      const isExpression = /^[a-zA-Z_{0-9]/.test(firstNonWs);
      if (!isExpression) {
        return '@' + value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(escapeAtSymbol);
  }
  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = escapeAtSymbol(val);
    }
    return result;
  }
  return value;
}

/**
 * Ensures an expression string starts with '@' prefix for Logic Apps.
 * Only adds '@' to values that are expressions (contain function calls).
 * Leaves literal values (strings, numbers, booleans) unchanged.
 *
 * @param value - The value to process (can be string, number, boolean, null, undefined)
 * @returns The value with '@' prefix if it's an expression, otherwise unchanged
 *
 * Examples:
 * - "triggerBody()?['field']" -> "@triggerBody()?['field']"
 * - "variables('x')" -> "@variables('x')"
 * - "emailaddress1" -> "emailaddress1" (literal string, no change)
 * - 42 -> 42 (number, no change)
 * - true -> true (boolean, no change)
 * - "@body('test')" -> "@body('test')" (already has @, no change)
 */
function ensureExpressionPrefix(value: any): any {
  // Handle non-string types - return as-is (numbers, booleans, null, undefined, objects)
  if (typeof value !== 'string') {
    return value;
  }

  // Handle empty string
  if (value === '') {
    return value;
  }

  // Already has @ prefix - return as-is
  if (value.startsWith('@')) {
    return value;
  }

  // If value contains @{...} embedded expressions, it's a mixed literal/expression string
  // These should NOT get @ prefix - they're already in the correct format
  if (value.includes('@{')) {
    return value;
  }

  // Check if this looks like a pure expression (not a literal string)
  // Expressions MUST start with a function call at the beginning
  // Examples: triggerBody(), variables('x'), body('Action'), guid(), etc.
  // But NOT: {"message": "..."} (starts with literal)
  // The expression must start immediately with an identifier followed by (
  const startsWithFunctionCall = /^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(value);

  if (startsWithFunctionCall) {
    // This is a pure expression, add @ prefix
    return `@${value}`;
  }

  // This is a literal value (plain string), return as-is
  return value;
}

/**
 * Convert expression string to Logic Apps condition format.
 *
 * Logic Apps supports two condition formats:
 * 1. String expression for simple conditions: "@greater(length(x), 10)"
 * 2. Object format for compound conditions: { "and": [ { "equals": [...] }, ... ] }
 *
 * This function converts compound conditions (with and/or/not) to object format,
 * but preserves simple expressions as strings for better parity with original flows.
 *
 * This is the inverse of conditionToExpression in generator-dsl.
 */
function expressionToCondition(expr: string, topLevel = true): any {
  if (!expr || typeof expr !== 'string') {
    return expr;
  }

  // Remove leading @ if present
  let s = expr.trim();
  if (s.startsWith('@')) {
    s = s.substring(1);
  }

  // Try to parse as function call
  const funcMatch = s.match(/^(\w+)\(([\s\S]*)\)$/);
  if (!funcMatch) {
    // Not a function call, return as-is (possibly with @ prefix restored for expressions)
    return expr.startsWith('@') ? expr : `@${expr}`;
  }

  const funcName = funcMatch[1];
  const argsStr = funcMatch[2];

  // Parse arguments (handling nested function calls and quoted strings)
  const args = parseArgs(argsStr);

  // Handle logical operators - these require object format
  if (funcName === 'and' || funcName === 'or') {
    const convertedArgs = args.map(arg => expressionToCondition(arg, false));
    return { [funcName]: convertedArgs };
  }

  // Handle not - requires object format
  if (funcName === 'not') {
    if (args.length === 1) {
      return { not: expressionToCondition(args[0], false) };
    }
  }

  // Handle comparison operators
  const comparisonOps = ['equals', 'greater', 'greaterOrEquals', 'less', 'lessOrEquals', 'contains', 'startsWith', 'endsWith'];
  if (comparisonOps.includes(funcName)) {
    // At top level, keep simple comparisons as strings for better parity
    // When nested inside and/or/not, use object format
    if (topLevel) {
      return expr.startsWith('@') ? expr : `@${s}`;
    }
    const convertedArgs = args.map(arg => convertArgValue(arg));
    return { [funcName]: convertedArgs };
  }

  // For other functions (not logical/comparison), return as expression string
  return expr.startsWith('@') ? expr : `@${s}`;
}

/**
 * Parse comma-separated arguments, respecting nested parentheses and quoted strings
 */
function parseArgs(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < argsStr.length; i++) {
    const c = argsStr[i];

    // PA expression syntax does NOT use `\` as an escape character — only `''`
    // inside a single-quoted string represents a literal `'`. Treating `\'` as
    // escaped (the previous behavior) breaks parsing of args like `'\'` (a
    // single backslash literal) by leaving the parser stuck inside the string.
    if (c === "'" && !inDoubleQuote) {
      if (inSingleQuote && argsStr[i + 1] === "'") {
        // Escape pair: pass through unchanged, advance past both quotes.
        current += "''";
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      current += c;
      continue;
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += c;
      continue;
    }

    // Handle parentheses (only when not in quotes)
    if (!inSingleQuote && !inDoubleQuote) {
      if (c === '(') {
        depth++;
        current += c;
        continue;
      }
      if (c === ')') {
        depth--;
        current += c;
        continue;
      }

      // Handle comma at depth 0
      if (c === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
    }

    current += c;
  }

  // Add last argument
  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

/**
 * Process a condition object for Logic Apps format.
 * For single comparison operators (equals, contains, etc.), returns them directly.
 * For multiple conditions, wraps them in { "and": [...] } or { "or": [...] }.
 *
 * @param condition - The parsed condition object from expressionToCondition
 * @returns The condition in Logic Apps format
 */
function wrapConditionForLogicApps(condition: any): any {
  // If it's a string expression, return as-is (will be prefixed with @ elsewhere)
  if (typeof condition === 'string') {
    return condition;
  }

  // If it's already a logical operator at top level, return as-is
  if (condition && typeof condition === 'object') {
    if ('and' in condition || 'or' in condition || 'not' in condition) {
      return condition;
    }
  }

  // For single comparison operators, return as-is
  // The parser now preserves the original and/or wrapper, so we don't need to add one
  return condition;
}

/**
 * Wrap a condition so the Power Automate maker-portal designer can render it
 * as visual condition rows. The designer requires the top-level expression to
 * be `{ and: [...] }` or `{ or: [...] }`; bare comparisons and raw `@expression`
 * strings fall back to code-only view, which the user can't edit in the UI.
 *
 * Strings are left alone (the expression isn't translatable to designer rows
 * anyway). Top-level `and`/`or` are passed through unchanged. Everything else
 * (bare comparisons, `not`, etc.) is wrapped in `{ and: [...] }`.
 */
function wrapForDesignerVisibility(condition: any): any {
  if (typeof condition === 'string') {
    return condition;
  }
  if (condition && typeof condition === 'object') {
    if ('and' in condition || 'or' in condition) {
      return condition;
    }
    return { and: [condition] };
  }
  return condition;
}

/**
 * Convert argument value back to Logic Apps format
 * - Quoted strings: 'value' -> "value" (remove quotes, will be string in JSON)
 * - null keyword -> "@null" (Logic Apps null)
 * - Expressions (starting with @ or containing function calls) -> keep as expression
 * - Numbers -> keep as numbers
 * - Booleans -> keep as boolean literals (true/false), not @true/@false
 */
function convertArgValue(arg: string): any {
  const trimmed = arg.trim();

  // Handle single-quoted strings — strip outer quotes and unescape PA `''` to `'`.
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  // Handle double-quoted strings
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  // Handle null
  if (trimmed === 'null' || trimmed === '@null') {
    return '@null';
  }

  // Handle numbers - but only plain numbers without @ prefix
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed);
  }

  // Handle @<number> patterns like @0, @1, @-5 - preserve for parity
  if (/^@-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }

  // Handle @true/@false - preserve as string expressions for parity
  if (trimmed === '@true') return '@true';
  if (trimmed === '@false') return '@false';

  // Handle boolean - return actual boolean values
  // Power Automate conditions use boolean literals in expression arrays
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // For expressions, ensure @ prefix
  if (trimmed.startsWith('@')) {
    return trimmed;
  }

  // Assume it's an expression if it contains parentheses (function call)
  if (trimmed.includes('(')) {
    return `@${trimmed}`;
  }

  // Default: return as expression
  return `@${trimmed}`;
}

/**
 * Denormalize SharePoint parameters from FlowForger IR format to Power Automate format
 * FlowForger uses: { dataset: '...', table: '...', fields: { Title: '...' } }
 * Power Automate uses: { dataset: '...', table: '...', item/Title: '...' }
 */
function denormalizeSpParams(operation: string, params: any): any {
  const p = { ...(params || {}) };

  // Flatten fields object to item/* format (for any operation that has fields)
  if (p.fields) {
    for (const [fieldName, value] of Object.entries(p.fields)) {
      p[`item/${fieldName}`] = value;
    }
    delete p.fields;
  }

  // Add legacy parameter names for compatibility (Power Automate may expect both)
  if (p.siteId && !p.dataset) p.dataset = p.siteId;
  if (p.listId && !p.table) p.table = p.listId;

  return p;
}

/**
 * Denormalize Office365 email parameters from FlowForger IR format to Power Automate format
 * FlowForger uses: { to: '...', subject: '...', body: '...' }
 * Power Automate uses: { 'emailMessage/To': '...', 'emailMessage/Subject': '...', 'emailMessage/Body': '...' }
 */
function denormalizeO365EmailParams(params: any): any {
  const p: Record<string, any> = {};

  // Email parameter mappings (camelCase -> emailMessage/PascalCase)
  const emailMappings: Record<string, string> = {
    'to': 'emailMessage/To',
    'subject': 'emailMessage/Subject',
    'body': 'emailMessage/Body',
    'cc': 'emailMessage/Cc',
    'bcc': 'emailMessage/Bcc',
    'importance': 'emailMessage/Importance',
    'isHtml': 'emailMessage/IsHtml',
    'replyTo': 'emailMessage/ReplyTo',
    'from': 'emailMessage/From',
    'attachments': 'emailMessage/Attachments',
  };

  for (const [key, value] of Object.entries(params || {})) {
    // Check if this key has a mapping
    const mappedKey = emailMappings[key];
    if (mappedKey) {
      p[mappedKey] = value;
    } else if (key.startsWith('emailMessage/')) {
      // Already in Power Automate format
      p[key] = value;
    } else {
      // Pass through unknown params as-is
      p[key] = value;
    }
  }

  return p;
}

/**
 * Denormalize Office365 calendar event parameters from FlowForger IR format to Power Automate format
 */
function denormalizeO365EventParams(params: any): any {
  const p: Record<string, any> = {};

  // Calendar event parameter mappings
  const eventMappings: Record<string, string> = {
    'subject': 'body/subject',
    'body': 'body/body',
    'start': 'body/start',
    'end': 'body/end',
    'timeZone': 'body/timeZone',
    'location': 'body/location',
    'requiredAttendees': 'body/requiredAttendees',
    'optionalAttendees': 'body/optionalAttendees',
    'isAllDay': 'body/isAllDay',
    'reminderMinutes': 'body/reminderMinutesBeforeStart',
    'showAs': 'body/showAs',
    'sensitivity': 'body/sensitivity',
    'categories': 'body/categories',
    'recurrence': 'body/recurrence',
  };

  for (const [key, value] of Object.entries(params || {})) {
    const mappedKey = eventMappings[key];
    if (mappedKey) {
      p[mappedKey] = value;
    } else if (key.startsWith('body/') || key.startsWith('event/')) {
      // Already in Power Automate format
      p[key] = value;
    } else {
      // Pass through unknown params (like calendarId, table_calendarId, etc.)
      p[key] = value;
    }
  }

  return p;
}

/**
 * Denormalize Office365 parameters based on operation type
 */
function denormalizeO365Params(operation: string, params: any): any {
  const op = operation.toLowerCase();

  // Operations that compose an outgoing email — params are nested under emailMessage/...
  // (Send, Reply, Forward variants). Get/Move/Mark/Flag/Delete operations keep
  // params at the top level.
  if (op.startsWith('send') || op.startsWith('reply') || op.startsWith('forward')) {
    return denormalizeO365EmailParams(params);
  }

  // Calendar operations
  if (op.includes('event') || op.includes('calendar') || op.includes('meeting')) {
    return denormalizeO365EventParams(params);
  }

  // Other operations - pass through as-is
  return params;
}

/**
 * Denormalize Word Online (Business) parameters from FlowForger IR format to Power Automate format
 * Power Automate uses specific parameter naming conventions for Word Online operations
 */
function denormalizeWordOnlineParams(operation: string, params: any): any {
  const p: Record<string, any> = {};

  // Map FlowForger parameter names to Power Automate format
  for (const [key, value] of Object.entries(params || {})) {
    // Standard file location parameters (no transformation needed)
    if (['source', 'drive', 'file'].includes(key)) {
      p[key] = value;
    }
    // Sensitivity label options
    else if (key === 'extractSensitivityLabel') {
      p['extractSensitivityLabel'] = value;
    }
    else if (key === 'fetchSensitivityLabelMetadata') {
      p['fetchSensitivityLabelMetadata'] = value;
    }
    // Template fields and other parameters pass through as-is
    // (Word Online uses flat parameter structure for template fields)
    else {
      p[key] = value;
    }
  }

  return p;
}

/**
 * Denormalize Excel Online (Business) parameters from FlowForger IR format to Power Automate format
 */
function denormalizeExcelOnlineParams(operation: string, params: any): any {
  const p: Record<string, any> = {};

  for (const [key, value] of Object.entries(params || {})) {
    // Standard file location parameters
    if (['source', 'drive', 'file', 'table'].includes(key)) {
      p[key] = value;
    }
    // Key column/value for row operations
    else if (key === 'idColumn' || key === 'id') {
      p[key] = value;
    }
    // Item/row data - needs to be flattened for Power Automate
    else if (key === 'item' && typeof value === 'object' && value !== null) {
      // Flatten item properties to top level with item/ prefix for Power Automate
      for (const [itemKey, itemValue] of Object.entries(value as Record<string, unknown>)) {
        p[`item/${itemKey}`] = itemValue;
      }
    }
    // OData query parameters
    else if (key.startsWith('$')) {
      p[key] = value;
    }
    // Table creation parameters
    else if (['TableName', 'Range', 'ColumnsNames'].includes(key)) {
      p[key] = value;
    }
    // Script parameters
    else if (['scriptId', 'ScriptParameters', 'scriptSource', 'scriptDrive'].includes(key)) {
      p[key] = value;
    }
    // All other parameters pass through
    else {
      p[key] = value;
    }
  }

  return p;
}

export interface EmitterConnectionRef {
  referenceName: string;
  apiId?: string;
  connectionReferenceLogicalName?: string;
  runtimeSource?: string;
}

export interface EmitterConfig {
  connections?: Record<string, EmitterConnectionRef>; // key by connector name (e.g., 'sharepoint', 'dataverse')
  connectionReferences?: Record<string, { connectionReferenceLogicalName: string; runtimeSource?: string; apiName?: string }>; // key by reference name (e.g., 'shared_sharepointonline_2') - preserves logical names and api.name
  includeMetadata?: boolean; // Include operationMetadataId fields (default: true)
  includeAuthentication?: boolean; // Include authentication parameters (default: true)
  childFlows?: Record<string, ChildFlowDefinition>; // Child flow name-to-GUID mapping
}

/**
 * Denormalize Teams parameters from IR format to Power Automate format.
 * Teams uses slash-delimited keys natively, so this is mostly a passthrough.
 */
function denormalizeTeamsParams(_operation: string, params: Record<string, any>): Record<string, any> {
  return params;
}

/**
 * Denormalize OneDrive for Business parameters from IR format to Power Automate format.
 * OneDrive uses mostly flat parameters, so this is largely a passthrough.
 */
function denormalizeOneDriveParams(_operation: string, params: Record<string, any>): Record<string, any> {
  return params;
}

function resolveConnection(connector: string, config?: EmitterConfig): EmitterConnectionRef {
  const fromCfg = config?.connections?.[connector];
  if (fromCfg) return fromCfg;
  if (connector === 'sharepoint') {
    return { referenceName: 'shared_sharepointonline', apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' };
  }
  if (connector === 'dataverse') {
    return { referenceName: 'shared_commondataserviceforapps', apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' };
  }
  if (connector === 'wordonlinebusiness') {
    return { referenceName: 'shared_wordonlinebusiness', apiId: '/providers/Microsoft.PowerApps/apis/shared_wordonlinebusiness' };
  }
  if (connector === 'excelonlinebusiness') {
    return { referenceName: 'shared_excelonlinebusiness', apiId: '/providers/Microsoft.PowerApps/apis/shared_excelonlinebusiness' };
  }
  if (connector === 'teams') {
    return { referenceName: 'shared_teams', apiId: '/providers/Microsoft.PowerApps/apis/shared_teams' };
  }
  if (connector === 'onedriveforbusiness') {
    return { referenceName: 'shared_onedriveforbusiness', apiId: '/providers/Microsoft.PowerApps/apis/shared_onedriveforbusiness' };
  }
  return { referenceName: `shared_${connector}` };
}

function generateMetadataId(): string {
  return randomUUID();
}

/**
 * Apply metadata to a definition.
 * - If the node has existing metadata, use it
 * - If includeMetadata is true and there's no existing metadata, generate new
 */
function applyMetadata(def: any, node: any, includeMetadata: boolean): void {
  // Add trackedProperties if present (must come before type for parity)
  if (node.trackedProperties) {
    def.trackedProperties = node.trackedProperties;
  }
  // Add description if present
  if (node.description) {
    def.description = node.description;
  }
  if (node.metadata) {
    def.metadata = node.metadata;
  } else if (includeMetadata) {
    def.metadata = { operationMetadataId: generateMetadataId() };
  }
  // Preserve operationOptions (e.g. "Asynchronous") if present
  if (node.operationOptions) {
    def.operationOptions = node.operationOptions;
  }
}

function emitActionsContainer(nodes: Node[], config?: EmitterConfig): Record<string, any> {
  const actions: Record<string, any> = {};
  const includeMetadata = config?.includeMetadata !== false;
  const includeAuth = config?.includeAuthentication !== false;

  let prevName: string | null = null;
  for (const node of (nodes as any[])) {
    if (node.type === 'trigger' || node.type === 'recurrence') continue;
    const name = node.name;
    let def: any;

    if (node.type === 'action') {
      const act = node as ActionNode;
      if (act.kind === 'http') {
        const httpInputs = act.inputs as any;
        def = {
          type: 'Http',
          inputs: {
            method: httpInputs.method,
            uri: httpInputs.url,
            headers: httpInputs.headers,
            body: httpInputs.body,
          },
          runAfter: {},
        };
        // Optional fields (query string parameters, cookies)
        if (httpInputs.queries) {
          def.inputs.queries = httpInputs.queries;
        }
        if (httpInputs.cookie !== undefined) {
          def.inputs.cookie = httpInputs.cookie;
        }
        // Add authentication if present (OAuth, API Key, etc.)
        if (httpInputs.authentication) {
          def.inputs.authentication = httpInputs.authentication;
        }
        // HTTP retryPolicy lives inside inputs (Logic Apps convention)
        if (act.retryPolicy) {
          def.inputs.retryPolicy = act.retryPolicy;
        }
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'compose') {
        const composeInputs = act.inputs as any;
        def = {
          type: 'Compose',
          inputs: escapeAtSymbol(composeInputs.value),
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'expression') {
        // Expression actions (IndexOf, Add, Subtract, etc.)
        const exprInputs = act.inputs as any;
        const { expressionKind, ...restInputs } = exprInputs;
        def = {
          type: 'Expression',
          kind: expressionKind,
          inputs: restInputs,
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'initializevariable') {
        const inputs = act.inputs as any;

        // Map variable types to Power Automate format (lowercase)
        const variableTypeMap: Record<string, string> = {
          'string': 'string',
          'String': 'string',
          'integer': 'integer',
          'Integer': 'integer',
          'float': 'float',
          'Float': 'float',
          'boolean': 'boolean',
          'Boolean': 'boolean',
          'array': 'array',
          'Array': 'array',
          'object': 'object',
          'Object': 'object',
        };

        const variableType = variableTypeMap[inputs.variableType] || inputs.variableType || 'string';

        // Build variable definition
        const variableDef: any = {
          name: inputs.variableName,
          type: variableType,
        };

        // Only include value if it's defined (not undefined)
        if (inputs.value !== undefined) {
          variableDef.value = ensureExpressionPrefix(inputs.value);
        }

        def = {
          type: 'InitializeVariable',
          inputs: {
            variables: [variableDef]
          },
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'setvariable') {
        const inputs = act.inputs as any;
        def = {
          type: 'SetVariable',
          inputs: {
            name: inputs.name,
            value: ensureExpressionPrefix(inputs.value)
          },
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'incrementvariable') {
        const inputs = act.inputs as any;
        // Only emit value if explicitly specified (default is 1 in Logic Apps)
        const emitInputs: any = { name: inputs.name };
        if (inputs.value !== undefined) {
          emitInputs.value = ensureExpressionPrefix(inputs.value);
        }
        def = {
          type: 'IncrementVariable',
          inputs: emitInputs,
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'decrementvariable') {
        const inputs = act.inputs as any;
        // Only emit value if explicitly specified (default is 1 in Logic Apps)
        const emitInputs: any = { name: inputs.name };
        if (inputs.value !== undefined) {
          emitInputs.value = ensureExpressionPrefix(inputs.value);
        }
        def = {
          type: 'DecrementVariable',
          inputs: emitInputs,
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'appendtoarrayvariable') {
        const inputs = act.inputs as any;
        def = {
          type: 'AppendToArrayVariable',
          inputs: {
            name: inputs.name,
            value: ensureExpressionPrefix(inputs.value)
          },
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'appendtostringvariable') {
        const inputs = act.inputs as any;
        def = {
          type: 'AppendToStringVariable',
          inputs: {
            name: inputs.name,
            value: ensureExpressionPrefix(inputs.value)
          },
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'join') {
        const inputs = act.inputs as any;
        def = {
          type: 'Join',
          inputs: {
            from: inputs.from,
            joinWith: inputs.joinWith || ','
          },
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'select') {
        const inputs = act.inputs as any;
        def = {
          type: 'Select',
          inputs: {
            from: inputs.from,
            select: inputs.select
          },
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'filterarray') {
        const inputs = act.inputs as any;
        def = {
          type: 'Query',
          inputs: {
            from: inputs.from,
            where: inputs.where
          },
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'parsejson') {
        const inputs = act.inputs as any;
        def = {
          type: 'ParseJson',
          inputs: {
            content: inputs.from,
            schema: escapeAtSymbol(inputs.schema || {})
          },
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'createcsvtable') {
        const inputs = act.inputs as any;
        def = {
          type: 'Table',
          inputs: {
            from: inputs.from,
            format: 'CSV'
          },
          runAfter: {},
        };
        if (inputs.columns) {
          def.inputs.columns = inputs.columns;
        }
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'createhtmltable') {
        const inputs = act.inputs as any;
        def = {
          type: 'Table',
          inputs: {
            from: inputs.from,
            format: 'HTML'
          },
          runAfter: {},
        };
        if (inputs.columns) {
          def.inputs.columns = inputs.columns;
        }
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'response') {
        const inputs = act.inputs as any;
        // Build inputs object with correct property order for PowerApp/VirtualAgent responses
        const responseInputs: any = {};
        if (inputs.schema) {
          responseInputs.schema = inputs.schema;
        }
        responseInputs.statusCode = inputs.statusCode || 200;
        // Only add body if present (not undefined)
        if (inputs.body !== undefined) {
          responseInputs.body = inputs.body;
        }
        // Only add headers if present and not empty
        if (inputs.headers && Object.keys(inputs.headers).length > 0) {
          responseInputs.headers = inputs.headers;
        }
        def = {
          type: 'Response',
          kind: inputs.kind || 'Http',
          inputs: responseInputs,
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'terminate') {
        const inputs = act.inputs as any;
        const runStatus = inputs.runStatus || 'Cancelled';
        const terminateInputs: Record<string, any> = { runStatus };
        // Only include runError for Failed status, and only if it has actual content.
        // Power Automate rejects runError on Succeeded/Cancelled, and empty {} causes
        // "unknown error" when publishing flows in Dataverse.
        if (runStatus === 'Failed' && inputs.runError &&
            (inputs.runError.code || inputs.runError.message)) {
          terminateInputs.runError = inputs.runError;
        }
        def = {
          type: 'Terminate',
          inputs: terminateInputs,
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'delay') {
        const inputs = act.inputs as any;
        def = {
          type: 'Wait',
          inputs: {
            interval: inputs.interval
          },
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'delayuntil') {
        const inputs = act.inputs as any;
        def = {
          type: 'Wait',
          inputs: {
            until: {
              timestamp: inputs.until
            }
          },
          runAfter: {},
        };
        applyMetadata(def, act, includeMetadata);
      } else if (act.kind === 'workflow') {
        const inputs = act.inputs as any;
        const rawRef = inputs.workflowReferenceName || inputs.workflowId;
        const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(rawRef || '');
        const resolvedRef = isGuid || !config?.childFlows
          ? rawRef
          : (config.childFlows[rawRef]?.workflowId || rawRef);
        const workflowInputs: any = {
          host: {
            workflowReferenceName: resolvedRef
          },
          body: inputs.body,
          headers: inputs.headers
        };
        // Workflow actions have retryPolicy inside inputs
        if (act.retryPolicy) {
          workflowInputs.retryPolicy = act.retryPolicy;
        }
        def = {
          type: 'Workflow',
          inputs: workflowInputs,
          runAfter: {},
        };
        // Add limit (timeout) if present
        if (act.limit) {
          def.limit = act.limit;
        }
        applyMetadata(def, act, includeMetadata);
      }
    } else if (node.type === 'scope') {
      def = {
        type: 'Scope',
        actions: emitActionsContainer((node as any).actions || {}, config),
        runAfter: {},
      };
      // Preserve runtimeConfiguration
      if (node.runtimeConfiguration) {
        def.runtimeConfiguration = node.runtimeConfiguration;
      }
      applyMetadata(def, node, includeMetadata);
    } else if (node.type === 'if') {
      const thenActions = emitActionsContainer((node as any).actions || [], config);
      const elseActions = emitActionsContainer((node as any).elseActions || [], config);
      // Determine condition format based on original format stored in IR
      // This preserves parity with the original Logic Apps JSON
      const conditionFormat = (node as any).conditionFormat;
      let condition: any;
      if (conditionFormat === 'string') {
        // Original was string format - keep as string
        condition = (node as any).condition;
        if (!condition.startsWith('@')) {
          condition = `@${condition}`;
        }
      } else if (conditionFormat === 'object') {
        // Original was object format - convert to object, preserving exact shape
        // (no auto-wrap in `and: [...]`) so parity with the source JSON is kept.
        condition = wrapConditionForLogicApps(expressionToCondition((node as any).condition, false));
      } else {
        // No format info - default to designer-visible object form.
        // The Power Automate maker-portal designer can only render the visual
        // condition rows if the top-level expression is `{ and: [...] }` or
        // `{ or: [...] }`. A bare `{ contains: [...] }` or a raw `@expression`
        // string renders as code-only and the user can't edit it in the UI.
        condition = wrapForDesignerVisibility(expressionToCondition((node as any).condition, false));
      }
      // Build If definition with correct key order: type, expression, actions, else, runAfter, ...
      def = {
        type: 'If',
        expression: condition,
        actions: thenActions,
      } as any;
      // Emit else block before runAfter to match Logic Apps key ordering
      if ((node as any).elseActions !== undefined) {
        def.else = { actions: elseActions };
      }
      def.runAfter = {};
      // Preserve runtimeConfiguration
      if (node.runtimeConfiguration) {
        def.runtimeConfiguration = node.runtimeConfiguration;
      }
      applyMetadata(def, node, includeMetadata);
    } else if (node.type === 'foreach') {
      // Try to convert @createArray(...) with primitives back to a literal array
      const foreachValue = convertCreateArrayToLiteralIfPossible((node as any).itemsExpression);
      // Preserve the source's casing of the "Foreach"/"foreach" type field if it differed
      // from the canonical PA UI form (rare, but some sources have lowercase).
      const typeCase = (node as any).typeCase as string | undefined;
      def = {
        type: typeCase || 'Foreach',
        foreach: foreachValue,
        actions: emitActionsContainer((node as any).actions || [], config),
        runAfter: {},
      };
      // Preserve runtimeConfiguration (e.g., concurrency settings)
      if (node.runtimeConfiguration) {
        def.runtimeConfiguration = node.runtimeConfiguration;
      }
      applyMetadata(def, node, includeMetadata);
    } else if (node.type === 'switch') {
      const switchNode = node as any;
      const switchCases: Record<string, any> = {};

      for (const caseItem of switchNode.cases || []) {
        // Use case name as key (or fall back to value for backward compatibility)
        const caseName = caseItem.name || String(caseItem.value);
        switchCases[caseName] = {
          case: caseItem.value,
          actions: emitActionsContainer(caseItem.actions || [], config)
        };
      }

      def = {
        type: 'Switch',
        expression: switchNode.expression,
        cases: switchCases,
        runAfter: {},
      };

      // Emit default case if it exists in the IR (even if empty)
      // This preserves empty default cases like { "actions": {} }
      if (switchNode.defaultActions !== undefined) {
        def.default = {
          actions: emitActionsContainer(switchNode.defaultActions, config)
        };
      }

      // Preserve runtimeConfiguration
      if (node.runtimeConfiguration) {
        def.runtimeConfiguration = node.runtimeConfiguration;
      }

      applyMetadata(def, node, includeMetadata);
    } else if (node.type === 'dountil') {
      const doUntilNode = node as any;
      // Keep the condition as a string expression (not JSON object) for Until loops
      // This preserves the original format and is more compact than JSON object format
      def = {
        type: 'Until',
        expression: doUntilNode.condition,
        actions: emitActionsContainer(doUntilNode.actions || [], config),
        limit: {
          count: doUntilNode.limit || 60,
          timeout: doUntilNode.timeout || 'PT1H'
        },
        runAfter: {},
      };
      // Preserve runtimeConfiguration
      if (node.runtimeConfiguration) {
        def.runtimeConfiguration = node.runtimeConfiguration;
      }
      applyMetadata(def, node, includeMetadata);
    } else if (node.type === 'connector') {
      const c = node as any;

      // Check if this is a legacy ApiConnection format
      // Can be stored in c.legacyApiConnection or c.params.__legacyApiConnection (for DSL roundtrip)
      const legacy = c.legacyApiConnection || c.params?.__legacyApiConnection;
      if (legacy) {
        const hostObj: any = {
          connection: {
            name: legacy.connectionExpression
          }
        };
        if (legacy.hostApi) {
          hostObj.api = legacy.hostApi;
        }
        def = {
          type: 'ApiConnection',
          inputs: {
            host: hostObj,
            method: legacy.method,
            body: legacy.body,
            path: legacy.path,
          },
          runAfter: {},
        };

        // Add queries if present (used by some legacy ApiConnection actions like Office 365 Users)
        if (legacy.queries) {
          def.inputs.queries = legacy.queries;
        }

        // Add headers if present
        if (legacy.headers) {
          def.inputs.headers = legacy.headers;
        }

        // Add inputs.api if present (some flows have api at inputs level in addition to host.api)
        if (legacy.inputsApi) {
          def.inputs.api = legacy.inputsApi;
        }

        // Use preserved authentication if present, otherwise add default if includeAuth
        if (c.authentication) {
          def.inputs.authentication = c.authentication;
        } else if (includeAuth) {
          def.inputs.authentication = "@parameters('$authentication')";
        }

        // Add retryPolicy if present
        if (c.retryPolicy) {
          def.inputs.retryPolicy = c.retryPolicy;
        }

        // Add limit (timeout) if present
        if (c.limit) {
          def.limit = c.limit;
        }

        applyMetadata(def, node, includeMetadata);
      } else {
        // Modern OpenApiConnection format
        const ref = resolveConnection(c.connector, config);
        const apiId = ref.apiId || `/providers/Microsoft.PowerApps/apis/shared_${c.connector}`;

        // Use connectionReferenceName if provided, otherwise use resolved reference
        const connectionName = c.connectionReferenceName || ref.referenceName;

        // Convert operation ID from FlowForger IR format to Power Automate format
        const paOperationId = mapIrOperationToPa(c.connector, c.operation);

        // Denormalize parameters based on connector type
        let params = c.params || {};
        if (c.connector === 'sharepoint') {
          params = denormalizeSpParams(paOperationId, params);
        } else if (c.connector === 'office365') {
          params = denormalizeO365Params(paOperationId, params);
        } else if (c.connector === 'wordonlinebusiness') {
          params = denormalizeWordOnlineParams(paOperationId, params);
        } else if (c.connector === 'excelonlinebusiness') {
          params = denormalizeExcelOnlineParams(paOperationId, params);
        } else if (c.connector === 'teams') {
          params = denormalizeTeamsParams(paOperationId, params);
        } else if (c.connector === 'onedriveforbusiness') {
          params = denormalizeOneDriveParams(paOperationId, params);
        }

        def = {
          type: 'OpenApiConnection',
          inputs: {
            host: {
              connectionName: connectionName,
              operationId: paOperationId,
              apiId
            },
          },
          runAfter: {},
        };
        // Preserve original presence/absence of `parameters` for parity. The PA UI omits the
        // parameters key entirely for parameterless operations (e.g. Office 365 MyProfile_V2).
        if (!(c as any).paramsOmitted) {
          def.inputs.parameters = params;
        }

        // Use preserved authentication if present, otherwise add default if includeAuth
        if (c.authentication) {
          def.inputs.authentication = c.authentication;
        } else if (includeAuth) {
          def.inputs.authentication = "@parameters('$authentication')";
        }

        // Add retryPolicy if present
        if (c.retryPolicy) {
          def.inputs.retryPolicy = c.retryPolicy;
        }

        // Add limit (timeout) if present
        if (c.limit) {
          def.limit = c.limit;
        }

        applyMetadata(def, node, includeMetadata);
      }
    } else if (node.type === 'connectorwebhook') {
      const c = node as any;

      // Check for legacy ApiConnectionWebhook format
      const legacyInfo = c.params?.__legacyApiConnectionWebhook || c.legacyApiConnectionWebhook;

      if (legacyInfo) {
        // Emit legacy ApiConnectionWebhook format
        const hostObj: any = {
          connection: {
            name: legacyInfo.connectionExpression
          }
        };
        if (legacyInfo.hostApi) {
          hostObj.api = legacyInfo.hostApi;
        }
        def = {
          type: 'ApiConnectionWebhook',
          inputs: {
            host: hostObj,
            path: legacyInfo.path,
            body: legacyInfo.body,
          },
          runAfter: {},
        };

        // Use preserved authentication if present, otherwise add default if includeAuth
        if (c.authentication) {
          def.inputs.authentication = c.authentication;
        } else if (includeAuth) {
          def.inputs.authentication = "@parameters('$authentication')";
        }

        // Add retryPolicy if present
        if (c.retryPolicy) {
          def.inputs.retryPolicy = c.retryPolicy;
        }

        // Add limit (timeout) if present
        if (c.limit) {
          def.limit = c.limit;
        }

        applyMetadata(def, node, includeMetadata);
      } else {
        // Modern OpenApiConnectionWebhook format
        const ref = resolveConnection(c.connector, config);
        const apiId = ref.apiId || `/providers/Microsoft.PowerApps/apis/shared_${c.connector}`;

        // Use connectionReferenceName if provided, otherwise use resolved reference
        const connectionName = c.connectionReferenceName || ref.referenceName;

        def = {
          type: 'OpenApiConnectionWebhook',
          inputs: {
            host: {
              connectionName: connectionName,
              operationId: c.operation,
              apiId
            },
            parameters: c.params || {},
          },
          runAfter: {},
        };

        // Use preserved authentication if present, otherwise add default if includeAuth
        if (c.authentication) {
          def.inputs.authentication = c.authentication;
        } else if (includeAuth) {
          def.inputs.authentication = "@parameters('$authentication')";
        }

        // Add retryPolicy if present
        if (c.retryPolicy) {
          def.inputs.retryPolicy = c.retryPolicy;
        }

        // Add limit (timeout) if present
        if (c.limit) {
          def.limit = c.limit;
        }

        applyMetadata(def, node, includeMetadata);
      }
    }

    if (!def) continue;

    // Use runAfter from node if present, otherwise add sequential dependency to prevName
    // Note: (node as any).runAfter can be {} (truthy) or undefined
    // - {} means explicit empty runAfter (parallel execution from trigger/container start)
    // - undefined means no runAfter was specified - default to sequential execution
    // - { actionName: ['Succeeded'] } means explicit sequential dependency
    if ((node as any).runAfter !== undefined) {
      def.runAfter = (node as any).runAfter;
    } else if (prevName) {
      def.runAfter = { [prevName]: ['Succeeded'] };
    } else {
      delete def.runAfter;
    }

    // Add runtimeConfiguration if present
    if ((node as any).runtimeConfiguration) {
      def.runtimeConfiguration = (node as any).runtimeConfiguration;
    }

    actions[name] = def;
    prevName = name;
  }
  return actions;
}

function collectUsedConnectors(nodes: Node[]): Set<string> {
  const usedConnectors = new Set<string>();

  for (const node of nodes) {
    // Check triggers
    if (node.type === 'trigger' && (node as TriggerNode).kind === 'connector') {
      const inputs = (node as TriggerNode).inputs as any;
      usedConnectors.add(inputs.connector);
    }

    // Check connector actions
    if (node.type === 'connector') {
      const connectorNode = node as any;
      usedConnectors.add(connectorNode.connector);
    }

    // Check webhook connector actions
    if (node.type === 'connectorwebhook') {
      const connectorNode = node as any;
      usedConnectors.add(connectorNode.connector);
    }

    // Recursively check nested nodes in control structures
    if (node.type === 'scope') {
      const scopeNode = node as any;
      const nestedConnectors = collectUsedConnectors(scopeNode.actions);
      nestedConnectors.forEach(c => usedConnectors.add(c));
    }
    if (node.type === 'if') {
      const ifNode = node as any;
      const thenConnectors = collectUsedConnectors(ifNode.actions);
      thenConnectors.forEach(c => usedConnectors.add(c));
      if (ifNode.elseActions) {
        const elseConnectors = collectUsedConnectors(ifNode.elseActions);
        elseConnectors.forEach(c => usedConnectors.add(c));
      }
    }
    if (node.type === 'foreach') {
      const foreachNode = node as any;
      const loopConnectors = collectUsedConnectors(foreachNode.actions);
      loopConnectors.forEach(c => usedConnectors.add(c));
    }
    if (node.type === 'switch') {
      const switchNode = node as any;
      switchNode.cases.forEach((c: any) => {
        const caseConnectors = collectUsedConnectors(c.actions);
        caseConnectors.forEach(conn => usedConnectors.add(conn));
      });
      if (switchNode.defaultActions) {
        const defaultConnectors = collectUsedConnectors(switchNode.defaultActions);
        defaultConnectors.forEach(c => usedConnectors.add(c));
      }
    }
    if (node.type === 'dountil') {
      const doUntilNode = node as any;
      const loopConnectors = collectUsedConnectors(doUntilNode.actions);
      loopConnectors.forEach(c => usedConnectors.add(c));
    }
  }

  return usedConnectors;
}

function collectConnectionReferenceNames(nodes: Node[], refNames: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    // Check triggers
    if (node.type === 'trigger' && (node as TriggerNode).kind === 'connector') {
      const inputs = (node as TriggerNode).inputs as any;
      if (inputs.connectionReferenceName) {
        refNames.add(inputs.connectionReferenceName);
      }
    }

    // Check connector actions
    if (node.type === 'connector') {
      const connectorNode = node as any;
      if (connectorNode.connectionReferenceName) {
        refNames.add(connectorNode.connectionReferenceName);
      }
    }

    // Check webhook connector actions
    if (node.type === 'connectorwebhook') {
      const connectorNode = node as any;
      if (connectorNode.connectionReferenceName) {
        refNames.add(connectorNode.connectionReferenceName);
      }
    }

    // Recursively check nested nodes in control structures
    if (node.type === 'scope') {
      const scopeNode = node as any;
      collectConnectionReferenceNames(scopeNode.actions, refNames);
    }
    if (node.type === 'if') {
      const ifNode = node as any;
      collectConnectionReferenceNames(ifNode.actions, refNames);
      if (ifNode.elseActions) {
        collectConnectionReferenceNames(ifNode.elseActions, refNames);
      }
    }
    if (node.type === 'foreach') {
      const foreachNode = node as any;
      collectConnectionReferenceNames(foreachNode.actions, refNames);
    }
    if (node.type === 'switch') {
      const switchNode = node as any;
      switchNode.cases.forEach((c: any) => {
        collectConnectionReferenceNames(c.actions, refNames);
      });
      if (switchNode.defaultActions) {
        collectConnectionReferenceNames(switchNode.defaultActions, refNames);
      }
    }
    if (node.type === 'dountil') {
      const doUntilNode = node as any;
      collectConnectionReferenceNames(doUntilNode.actions, refNames);
    }
  }

  return refNames;
}

function buildConnectionReferences(
  config?: EmitterConfig,
  usedConnectors?: Set<string>,
  connectionRefNames?: Set<string>,
  irConnectionReferences?: Record<string, ConnectionReference>
): Record<string, any> {
  const connections = config?.connections || {};
  const refs: Record<string, any> = {};

  // Build a set of base API names that are covered by explicit connection reference names
  // e.g., if connectionRefNames has 'shared_sharepointonline-1', then 'shared_sharepointonline' is covered
  const coveredBaseNames = new Set<string>();
  if (connectionRefNames) {
    for (const refName of connectionRefNames) {
      // Extract base name (remove trailing -N or _N suffix)
      const baseName = refName.replace(/[-_]\d+$/, '');
      coveredBaseNames.add(baseName);
      coveredBaseNames.add(refName); // Also add the full name
    }
  }

  // Phase 0: Add connection references from IR (primary source - no config needed)
  // This is the preferred source when connection references are embedded in the IR
  // Supports two patterns:
  // 1. Solution-aware: uses connectionReferenceLogicalName
  // 2. Embedded/direct: uses connectionName (the actual connection ID)
  if (irConnectionReferences) {
    for (const [refName, connRef] of Object.entries(irConnectionReferences)) {
      // Extract api.name from apiId (e.g., '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' -> 'shared_sharepointonline')
      const apiName = connRef.apiId.split('/').pop() || refName;

      // Build connection object based on available fields
      const connection: Record<string, string> = {};
      if (connRef.connectionName) {
        // Embedded/direct connection - use connection.name
        connection.name = connRef.connectionName;
      } else if (connRef.connectionReferenceLogicalName) {
        // Solution-aware - use connectionReferenceLogicalName
        connection.connectionReferenceLogicalName = connRef.connectionReferenceLogicalName;
      }

      refs[refName] = {
        ...(connRef.impersonation && { impersonation: connRef.impersonation }),
        runtimeSource: connRef.runtimeSource || 'embedded',
        connection,
        api: {
          name: apiName
        }
      };

      // Mark this as covered so we don't add duplicates
      coveredBaseNames.add(refName);
      const baseName = refName.replace(/[-_]\d+$/, '');
      coveredBaseNames.add(baseName);
      // Also mark the API name as covered to prevent Phase 3 from auto-generating
      // a duplicate reference for the same connector under a different key
      coveredBaseNames.add(apiName);
    }
  }

  // Phase 1: Add explicit connection reference names from IR (for preserved references)
  // This handles cases where connectionReferenceName is on nodes but full metadata is in config
  if (connectionRefNames) {
    for (const refName of connectionRefNames) {
      // Skip if already added from IR connection references
      if (refs[refName]) continue;

      // Check if there's a preserved logical name in connectionReferences config
      const preservedRef = config?.connectionReferences?.[refName];

      // Use preserved apiName if available, otherwise extract from reference name
      // Extraction handles both patterns:
      // - 'shared_sharepointonline_2' -> 'shared_sharepointonline' (underscore + number)
      // - 'shared_commondataserviceforapps-1' -> 'shared_commondataserviceforapps' (hyphen + number)
      const apiName = preservedRef?.apiName || refName.replace(/[-_]\d+$/, '');

      // Use preserved logical name if available, otherwise generate new one
      const logicalName = preservedRef?.connectionReferenceLogicalName || `new_${refName}_${randomUUID().split('-')[0]}`;

      refs[refName] = {
        runtimeSource: preservedRef?.runtimeSource || 'embedded',
        connection: {
          connectionReferenceLogicalName: logicalName
        },
        api: {
          name: apiName
        }
      };
    }
  }

  // Phase 2: Add connection references from config (only if not already covered by explicit refs)
  for (const [connectorName, connConfig] of Object.entries(connections)) {
    // Only include this connection if it's actually used in the flow (or if we're not filtering)
    if (usedConnectors && !usedConnectors.has(connectorName)) {
      continue;
    }

    // Skip if this base reference name is already covered by explicit connection refs
    // e.g., skip 'shared_sharepointonline' if we have 'shared_sharepointonline-1' or 'shared_sharepointonline-2'
    if (coveredBaseNames.has(connConfig.referenceName)) {
      continue;
    }

    // Check if there's a preserved logical name in connectionReferences config
    const preservedRef = config?.connectionReferences?.[connConfig.referenceName];
    const logicalName = preservedRef?.connectionReferenceLogicalName
      || connConfig.connectionReferenceLogicalName
      || `new_${connConfig.referenceName}_${randomUUID().split('-')[0]}`;

    refs[connConfig.referenceName] = {
      runtimeSource: preservedRef?.runtimeSource || connConfig.runtimeSource || 'embedded',
      connection: {
        connectionReferenceLogicalName: logicalName
      },
      api: {
        name: connConfig.referenceName
      }
    };
  }

  // Phase 3: Auto-generate connection references for used connectors not in config and not explicitly named
  if (usedConnectors) {
    for (const connectorName of usedConnectors) {
      // Skip if already added from config
      const connConfig = connections[connectorName];
      if (connConfig) continue;

      // Auto-generate connection reference for this connector
      const connRef = resolveConnection(connectorName, config);

      // Skip if already added as explicit ref or covered by explicit refs
      if (refs[connRef.referenceName] || coveredBaseNames.has(connRef.referenceName)) continue;

      // Check if there's a preserved logical name in connectionReferences config
      const preservedRef = config?.connectionReferences?.[connRef.referenceName];

      // Use preserved logical name if available, otherwise generate new one
      const logicalName = preservedRef?.connectionReferenceLogicalName || `new_${connRef.referenceName}_${randomUUID().split('-')[0]}`;

      refs[connRef.referenceName] = {
        runtimeSource: preservedRef?.runtimeSource || 'embedded',
        connection: {
          connectionReferenceLogicalName: logicalName
        },
        api: {
          name: connRef.referenceName
        }
      };
    }
  }

  return refs;
}

export function emitLogicAppsJson(flow: FlowIR, config?: EmitterConfig) {
  //console.error('[FlowForger] Converting: IR → Logic Apps JSON');

  const trigger = flow.nodes.find((n) => n.type === 'trigger' || n.type === 'recurrence') as TriggerNode | RecurrenceTriggerNode | undefined;
  if (!trigger) throw new Error('Flow must have a trigger');

  const effectiveConfig = flow.childFlows ? { ...config, childFlows: flow.childFlows } : config;
  const actionsEntries = emitActionsContainer((flow.nodes as any[]), effectiveConfig);
  const includeAuth = config?.includeAuthentication !== false;
  const includeMetadata = config?.includeMetadata !== false;

  // Build trigger definition
  let triggerDef: any;
  if (trigger.type === 'recurrence') {
    const recTrigger = trigger as RecurrenceTriggerNode;
    const inputs = recTrigger.inputs;
    const triggerName = trigger.name || 'Recurrence';

    // Build the recurrence object
    const recurrence: any = {
      frequency: inputs.frequency,
      interval: inputs.interval,
    };

    // Add optional fields
    if (inputs.count !== undefined) recurrence.count = inputs.count;
    if (inputs.startTime) recurrence.startTime = inputs.startTime;
    if (inputs.endTime) recurrence.endTime = inputs.endTime;
    if (inputs.timeZone) recurrence.timeZone = inputs.timeZone;
    if (inputs.schedule) recurrence.schedule = inputs.schedule;

    triggerDef = {
      [triggerName]: {
        type: 'Recurrence',
        recurrence,
      },
    };

    // Add conditions if present (including empty arrays)
    if (recTrigger.conditions !== undefined) {
      triggerDef[triggerName].conditions = recTrigger.conditions;
    }

    // Add runtimeConfiguration if present
    if (recTrigger.runtimeConfiguration) {
      triggerDef[triggerName].runtimeConfiguration = recTrigger.runtimeConfiguration;
    }

    // Add evaluatedRecurrence if present (Power Automate's effective schedule)
    if (recTrigger.evaluatedRecurrence) {
      const evalRec = recTrigger.evaluatedRecurrence;
      const evaluatedRecurrence: any = {
        frequency: evalRec.frequency,
        interval: evalRec.interval,
      };
      if (evalRec.startTime) evaluatedRecurrence.startTime = evalRec.startTime;
      if (evalRec.endTime) evaluatedRecurrence.endTime = evalRec.endTime;
      if (evalRec.timeZone) evaluatedRecurrence.timeZone = evalRec.timeZone;
      if (evalRec.schedule) evaluatedRecurrence.schedule = evalRec.schedule;
      triggerDef[triggerName].evaluatedRecurrence = evaluatedRecurrence;
    }

    // Add correlation if present
    if (recTrigger.correlation !== undefined) {
      triggerDef[triggerName].correlation = recTrigger.correlation;
    }

    // Add description if present
    if (recTrigger.description) {
      triggerDef[triggerName].description = recTrigger.description;
    }

    if (recTrigger.metadata) {
      triggerDef[triggerName].metadata = recTrigger.metadata;
    } else if (includeMetadata) {
      triggerDef[triggerName].metadata = { operationMetadataId: generateMetadataId() };
    }
  } else if (trigger.kind === 'manual') {
    const manualInputs = trigger.inputs as any;
    const triggerName = trigger.name || 'manual';
    const inputs: any = {
      schema: manualInputs.schema || {
        type: 'object',
        properties: {},
        required: []
      }
    };
    if (manualInputs.headersSchema) inputs.headersSchema = manualInputs.headersSchema;
    if (manualInputs.triggerAuthenticationType) inputs.triggerAuthenticationType = manualInputs.triggerAuthenticationType;
    triggerDef = {
      [triggerName]: {
        type: 'Request',
        kind: manualInputs.triggerKind || 'Button',
        inputs,
      },
    };

    // Add conditions if present (including empty arrays)
    if (trigger.conditions !== undefined) {
      triggerDef[triggerName].conditions = trigger.conditions;
    }

    // Add runtimeConfiguration if present
    if (trigger.runtimeConfiguration) {
      triggerDef[triggerName].runtimeConfiguration = trigger.runtimeConfiguration;
    }

    // Add correlation if present
    if (trigger.correlation !== undefined) {
      triggerDef[triggerName].correlation = trigger.correlation;
    }

    // Add description if present
    if (trigger.description) {
      triggerDef[triggerName].description = trigger.description;
    }

    if (trigger.metadata) {
      triggerDef[triggerName].metadata = trigger.metadata;
    } else if (includeMetadata) {
      triggerDef[triggerName].metadata = { operationMetadataId: generateMetadataId() };
    }
  } else if (trigger.kind === 'http') {
    const httpInputs = trigger.inputs as any;
    const triggerName = trigger.name || 'manual';
    const inputs: any = {};
    if (httpInputs.schema) inputs.schema = httpInputs.schema;
    if (httpInputs.headersSchema) inputs.headersSchema = httpInputs.headersSchema;
    if (httpInputs.triggerAuthenticationType) inputs.triggerAuthenticationType = httpInputs.triggerAuthenticationType;
    // Emit method when present in IR. Source flows that omit method (using the
    // POST default) leave method undefined in IR so the field stays absent.
    if (httpInputs.method !== undefined) inputs.method = httpInputs.method;
    if (httpInputs.path) inputs.path = httpInputs.path;
    triggerDef = {
      [triggerName]: {
        type: 'Request',
        kind: httpInputs.triggerKind || 'Http',
        inputs,
      },
    };

    // Add conditions if present (including empty arrays)
    if (trigger.conditions !== undefined) {
      triggerDef[triggerName].conditions = trigger.conditions;
    }

    // Add runtimeConfiguration if present
    if (trigger.runtimeConfiguration) {
      triggerDef[triggerName].runtimeConfiguration = trigger.runtimeConfiguration;
    }

    // Add correlation if present
    if (trigger.correlation !== undefined) {
      triggerDef[triggerName].correlation = trigger.correlation;
    }

    // Add description if present
    if (trigger.description) {
      triggerDef[triggerName].description = trigger.description;
    }

    if (trigger.metadata) {
      triggerDef[triggerName].metadata = trigger.metadata;
    } else if (includeMetadata) {
      triggerDef[triggerName].metadata = { operationMetadataId: generateMetadataId() };
    }
  } else if (trigger.kind === 'connector') {
    const connInputs = trigger.inputs as any;

    // Check if this is a legacy ApiConnection trigger
    // Can be stored in connInputs.legacyApiConnection or connInputs.params.__legacyApiConnection (for DSL roundtrip)
    const legacy = connInputs.legacyApiConnection || connInputs.params?.__legacyApiConnection;
    if (legacy) {
      // Filter out __legacyApiConnection from params
      const cleanParams = { ...connInputs.params };
      delete cleanParams.__legacyApiConnection;

      // Check which legacy format: fetch/subscribe (ApiConnectionNotification), method/path, or schema format
      if (legacy.fetch !== undefined || legacy.subscribe !== undefined) {
        // ApiConnectionNotification trigger (e.g., "When an email is flagged")
        const hostObj: any = {
          connection: {
            name: legacy.connectionExpression
          }
        };
        // Add host.api if present (contains runtimeUrl)
        if (legacy.hostApi) {
          hostObj.api = legacy.hostApi;
        }

        const inputsObj: any = {
          host: hostObj,
        };
        if (legacy.fetch) inputsObj.fetch = legacy.fetch;
        if (legacy.subscribe) inputsObj.subscribe = legacy.subscribe;

        triggerDef = {
          [trigger.name]: {
            type: connInputs.triggerType || 'ApiConnectionNotification',
            inputs: inputsObj,
          },
        };

        // Add authentication if present
        if (connInputs.authentication) {
          triggerDef[trigger.name].inputs.authentication = connInputs.authentication;
        } else if (includeAuth) {
          triggerDef[trigger.name].inputs.authentication = "@parameters('$authentication')";
        }
      } else if (legacy.method !== undefined || legacy.path !== undefined) {
        // Legacy ApiConnection trigger with method and path (e.g., SharePoint "When item created")
        const hostObj: any = {
          connection: {
            name: legacy.connectionExpression
          }
        };
        // Add host.api if present (contains runtimeUrl)
        if (legacy.hostApi) {
          hostObj.api = legacy.hostApi;
        }
        triggerDef = {
          [trigger.name]: {
            type: 'ApiConnection',
            inputs: {
              host: hostObj,
              method: legacy.method,
              path: legacy.path,
            },
          },
        };

        // Add authentication if present
        if (connInputs.authentication) {
          triggerDef[trigger.name].inputs.authentication = connInputs.authentication;
        } else if (includeAuth) {
          triggerDef[trigger.name].inputs.authentication = "@parameters('$authentication')";
        }
      } else {
        // Legacy Request/ApiConnection trigger with schema (e.g., Dataverse triggers, SharePoint "For a selected file")
        const hostObj: any = {
          connection: {
            name: legacy.connectionExpression
          }
        };
        // Add host.api if present (contains runtimeUrl)
        if (legacy.hostApi) {
          hostObj.api = legacy.hostApi;
        }

        const inputsObj: any = {
          schema: legacy.schema,
          host: hostObj,
          operationId: connInputs.operation,
          parameters: cleanParams,
        };
        // Add headersSchema if present
        if (legacy.headersSchema) {
          inputsObj.headersSchema = legacy.headersSchema;
        }

        triggerDef = {
          [trigger.name]: {
            type: 'Request',
            kind: 'ApiConnection',
            inputs: inputsObj,
          },
        };
      }

      // Add recurrence if present
      if (connInputs.recurrence) {
        triggerDef[trigger.name].recurrence = connInputs.recurrence;
      }

      // Add splitOn if present
      if (connInputs.splitOn) {
        triggerDef[trigger.name].splitOn = connInputs.splitOn;
      }

      // Add conditions if present (including empty arrays)
      if (trigger.conditions !== undefined) {
        triggerDef[trigger.name].conditions = trigger.conditions;
      }

      // Add runtimeConfiguration if present
      if (trigger.runtimeConfiguration) {
        triggerDef[trigger.name].runtimeConfiguration = trigger.runtimeConfiguration;
      }

      // Add correlation if present
      if (trigger.correlation !== undefined) {
        triggerDef[trigger.name].correlation = trigger.correlation;
      }

      // Add description if present
      if (trigger.description) {
        triggerDef[trigger.name].description = trigger.description;
      }

      if (trigger.metadata) {
        triggerDef[trigger.name].metadata = trigger.metadata;
      } else if (includeMetadata) {
        triggerDef[trigger.name].metadata = { operationMetadataId: generateMetadataId() };
      }
    } else {
      // Modern connector trigger format
      const ref = resolveConnection(connInputs.connector, config);
      const apiId = ref.apiId || `/providers/Microsoft.PowerApps/apis/shared_${connInputs.connector}`;

      // Use connectionReferenceName if provided, otherwise use resolved reference
      const connectionName = connInputs.connectionReferenceName || ref.referenceName;

      // Use preserved trigger type, or default to OpenApiConnectionNotification
      const triggerType = connInputs.triggerType || 'OpenApiConnectionNotification';

      triggerDef = {
        [trigger.name]: {
          type: triggerType,
          inputs: {
            host: {
              connectionName: connectionName,
              operationId: connInputs.operation,
              apiId
            },
            parameters: connInputs.params || {},
          },
        },
      };

      // Add splitOn if present
      if (connInputs.splitOn) {
        triggerDef[trigger.name].splitOn = connInputs.splitOn;
      }

      // Add recurrence if present
      if (connInputs.recurrence) {
        triggerDef[trigger.name].recurrence = connInputs.recurrence;
      }

      // Add conditions if present (including empty arrays)
      if (trigger.conditions !== undefined) {
        triggerDef[trigger.name].conditions = trigger.conditions;
      }

      // Add runtimeConfiguration if present
      if (trigger.runtimeConfiguration) {
        triggerDef[trigger.name].runtimeConfiguration = trigger.runtimeConfiguration;
      }

      // Use preserved authentication if present, otherwise add default if includeAuth
      if (connInputs.authentication) {
        triggerDef[trigger.name].inputs.authentication = connInputs.authentication;
      } else if (includeAuth) {
        triggerDef[trigger.name].inputs.authentication = "@parameters('$authentication')";
      }

      // Add retryPolicy if present
      if (connInputs.retryPolicy) {
        triggerDef[trigger.name].inputs.retryPolicy = connInputs.retryPolicy;
      }

      // Add correlation if present
      if (trigger.correlation !== undefined) {
        triggerDef[trigger.name].correlation = trigger.correlation;
      }

      // Add description if present
      if (trigger.description) {
        triggerDef[trigger.name].description = trigger.description;
      }

      if (trigger.metadata) {
        triggerDef[trigger.name].metadata = trigger.metadata;
      } else if (includeMetadata) {
        triggerDef[trigger.name].metadata = { operationMetadataId: generateMetadataId() };
      }
    }
  } else {
    throw new Error(`Unsupported trigger kind: ${trigger.kind}`);
  }

  // Build parameters - preserve original order from flow.parameters if present
  // This maintains parity with the original Logic Apps JSON
  const params: Record<string, any> = {};

  if (flow.parameters) {
    // Use parameters from IR (preserves original order)
    for (const key of Object.keys(flow.parameters)) {
      params[key] = flow.parameters[key];
    }
  }

  // Add default auth parameters only if not already present and includeAuth is true
  if (includeAuth) {
    if (!params['$authentication']) {
      // Create new params with auth first (Logic Apps standard order)
      const orderedParams: Record<string, any> = {
        '$authentication': {
          defaultValue: {},
          type: 'SecureObject'
        },
        '$connections': {
          defaultValue: {},
          type: 'Object'
        },
        ...params
      };
      Object.assign(params, orderedParams);
      // Clear and reassign to get correct order
      for (const key of Object.keys(params)) {
        delete params[key];
      }
      Object.assign(params, orderedParams);
    } else if (!params['$connections']) {
      // $authentication exists but $connections doesn't - just add $connections
      params['$connections'] = {
        defaultValue: {},
        type: 'Object'
      };
    }
  }

  // Build definition in correct Logic Apps key order:
  // metadata, $schema, contentVersion, parameters, triggers, actions, outputs
  const definition: any = {};

  // Preserve workflow-level metadata (creator, provisioningMethod, etc.) if present
  if (flow.workflowMetadata) {
    definition.metadata = flow.workflowMetadata;
  }

  definition.$schema = flow.metadata?.$schema ||
    'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#';
  definition.contentVersion = flow.metadata?.contentVersion || '1.0.0.0';

  // Add parameters before triggers (Logic Apps standard order)
  if (Object.keys(params).length > 0) {
    definition.parameters = params;
  }

  // Add triggers and actions
  definition.triggers = triggerDef;
  definition.actions = actionsEntries;

  // Add outputs after actions
  if (flow.outputs !== undefined) {
    definition.outputs = flow.outputs;
  }

  // Add staticResults for testing mock responses
  if (flow.staticResults !== undefined) {
    definition.staticResults = flow.staticResults;
  }

  // Include description if present in flow IR
  if (flow.description) {
    definition.description = flow.description;
  }

  // Collect connectors used in this flow
  const usedConnectors = collectUsedConnectors(flow.nodes);

  // Collect explicit connection reference names from IR (for preserving multiple connections)
  const connectionRefNames = collectConnectionReferenceNames(flow.nodes);

  // Build connection references only for used connectors
  // Prefer IR connection references (flow.connectionReferences) over config
  const connectionReferences = buildConnectionReferences(config, usedConnectors, connectionRefNames, flow.connectionReferences);

  // Return full Dataverse structure
  return {
    properties: {
      connectionReferences,
      definition
    },
    schemaVersion: flow.metadata?.schemaVersion || '1.0.0.0'
  };
}

export const Emitter = { emitLogicAppsJson };
