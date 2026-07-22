import type { FlowIR, FlowForgerConfig, ParityConfig } from '@flowforger/ir';
import { DEFAULT_PARITY_CONFIG } from '@flowforger/ir';
import { emitLogicAppsJson } from '@flowforger/emitter-logicapps';
import { parseLogicAppsToIR, generateNativeDslFromIR, transformCode, resetIdCounter } from '@flowforger/dsl-native';

/**
 * Thrown when the generated native DSL fails to transform back to IR during the
 * parity round-trip. The CLI maps this to exit code 2.
 */
export class ParityTransformError extends Error {
  readonly transformCause: unknown;
  constructor(cause: unknown) {
    super('Failed to transform generated DSL code');
    this.name = 'ParityTransformError';
    this.transformCause = cause;
  }
}

export interface ParityDifference {
  path: string;
  type: 'missing_in_output' | 'extra_in_output' | 'value_mismatch' | 'type_mismatch';
  original: string;
  output: string;
}

export interface ParityResult {
  ok: boolean;
  category?: string;
  totalDiffs?: number;
  differences?: ParityDifference[];
}

interface SemanticDiff {
  path: string;
  type: 'missing_in_output' | 'extra_in_output' | 'value_mismatch' | 'type_mismatch';
  originalValue?: any;
  outputValue?: any;
}

/**
 * Remove fields that are expected to differ (metadata IDs, etc.) and normalize
 * empty runAfter, default do-until limits, increment/decrement values, and
 * description whitespace so they compare equal across a round-trip.
 */
function removeIgnoredFields(o: any, parentType?: string): any {
  if (Array.isArray(o)) return o.map(item => removeIgnoredFields(item, parentType));
  if (o && typeof o === 'object') {
    const result: any = {};
    const currentType = o.type;
    for (const key of Object.keys(o)) {
      // Skip operationMetadataId as it's regenerated each time
      if (key === 'operationMetadataId') continue;
      const cleaned = removeIgnoredFields(o[key], currentType);
      // Skip undefined/null values - they're semantically equivalent to absent
      if (cleaned === undefined || cleaned === null) {
        continue;
      }
      // Skip metadata objects that are empty after cleaning (only had operationMetadataId)
      if (key === 'metadata' && typeof cleaned === 'object' && Object.keys(cleaned).length === 0) {
        continue;
      }
      // Normalize empty runAfter: {}, undefined, and absent are semantically the same
      // Remove empty runAfter or undefined runAfter to treat them as equivalent for parity
      if (key === 'runAfter') {
        if (typeof cleaned === 'object' && Object.keys(cleaned).length === 0) {
          continue;
        }
      }
      // Normalize do-until limit: add defaults if missing, so { timeout: "PT3M" } becomes { count: 60, timeout: "PT3M" }
      // This handles the case where DSL doesn't preserve timeout separately
      if (key === 'limit' && typeof cleaned === 'object') {
        if (cleaned.count === undefined) cleaned.count = 60;
        if (cleaned.timeout === undefined) cleaned.timeout = 'PT1H';
      }
      // Normalize IncrementVariable/DecrementVariable inputs: add value: 1 if missing
      // DSL always outputs explicit +1/-1, so we need to normalize for parity
      if (key === 'inputs' && typeof cleaned === 'object' &&
          (currentType === 'IncrementVariable' || currentType === 'DecrementVariable')) {
        if (cleaned.value === undefined) cleaned.value = 1;
      }
      // Normalize description: trim trailing whitespace
      // DSL JSDoc format can't preserve trailing spaces reliably
      if (key === 'description' && typeof cleaned === 'string') {
        result[key] = cleaned.trim();
        continue;
      }
      result[key] = cleaned;
    }
    return result;
  }
  return o;
}

// Normalize whitespace in Power Automate expressions for comparison.
// This handles cosmetic differences like:
//   @concat('"',variables('x'),'"') vs @concat('"', variables('x'), '"')
//   @sort(arr, 'prop') vs @sort(arr,'prop')
//   @ body('action') vs @body('action')
//   \r\n vs \n (line endings)
//   @{expr\n} vs @{expr} (trailing whitespace in expressions)

/**
 * Find matching closing brace for an @{ expression, handling nested braces.
 */
function findMatchingBrace(str: string, startIdx: number): number {
  let depth = 1;
  let i = startIdx;
  while (i < str.length && depth > 0) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') depth--;
    if (depth > 0) i++;
  }
  return depth === 0 ? i : -1;
}

/**
 * Normalize whitespace inside @{...} expression blocks.
 */
function normalizeEmbeddedExpressions(str: string): string {
  let result = '';
  let i = 0;
  while (i < str.length) {
    if (str[i] === '@' && str[i + 1] === '{') {
      // Found start of @{...} expression
      const exprStart = i + 2;
      const closeIdx = findMatchingBrace(str, exprStart);
      if (closeIdx > 0) {
        let inner = str.substring(exprStart, closeIdx);
        // Collapse all whitespace (including newlines) to single space
        inner = inner.replace(/\s+/g, ' ').trim();
        // Remove spaces after ( and before )
        inner = inner.replace(/\(\s+/g, '(');
        inner = inner.replace(/\s+\)/g, ')');
        result += `@{${inner}}`;
        i = closeIdx + 1;
      } else {
        result += str[i];
        i++;
      }
    } else {
      result += str[i];
      i++;
    }
  }
  return result;
}

function normalizeExpressionWhitespace(expr: string): string {
  let result = expr;
  // Normalize line endings: \r\n -> \n
  result = result.replace(/\r\n/g, '\n');
  // Normalize space after @ in expressions: "@ func(" -> "@func("
  // Match @ followed by optional whitespace then a word character (function name start)
  result = result.replace(/@\s+(\w)/g, '@$1');
  // Normalize space between function name and opening parenthesis: "not (" -> "not("
  // Match word characters followed by optional space then opening paren
  result = result.replace(/(\w)\s+\(/g, '$1(');

  // Normalize whitespace inside @{...} expression blocks with proper brace matching
  result = normalizeEmbeddedExpressions(result);

  // Normalize comma spacing: ensure consistent spacing around commas
  // Handle comma spacing within function calls and expressions
  result = result.replace(/\s*,\s*/g, ', ');

  // Normalize trailing whitespace before closing parens/braces: ")\n}" -> ")}"
  result = result.replace(/\)\s+}/g, ')}');

  // Normalize trailing newlines at end of string values
  result = result.replace(/\n+$/g, '');

  // Normalize spaces before closing paren: "value )" -> "value)"
  result = result.replace(/\s+\)/g, ')');

  // Normalize spaces after opening paren: "( value" -> "(value"
  result = result.replace(/\(\s+/g, '(');

  return result;
}

/**
 * Normalize function names to lowercase in Power Automate expressions.
 * PA functions are case-insensitive, so @Trim(x) and @trim(x) are equivalent.
 */
function normalizeFunctionCase(expr: string): string {
  // List of known PA functions to normalize (case-insensitive matching)
  const paFunctions = [
    'concat', 'substring', 'replace', 'toLower', 'toUpper', 'trim', 'split', 'join',
    'indexOf', 'lastIndexOf', 'guid', 'base64', 'base64ToString', 'uriComponent', 'uriComponentToString',
    'int', 'float', 'abs', 'ceil', 'floor', 'round', 'add', 'sub', 'mul', 'div', 'mod', 'min', 'max', 'rand',
    'createArray', 'range', 'length', 'empty', 'first', 'last', 'skip', 'take', 'union', 'intersection',
    'equals', 'greater', 'less', 'greaterOrEquals', 'lessOrEquals',
    'and', 'or', 'not', 'if', 'coalesce',
    'utcNow', 'addDays', 'addHours', 'addMinutes', 'formatDateTime', 'addSeconds',
    'json', 'string', 'bool', 'array', 'decodeBase64', 'encodeUriComponent', 'decodeUriComponent',
    'startsWith', 'endsWith', 'contains', 'nthIndexOf', 'slice', 'sort', 'reverse', 'chunk',
    'body', 'outputs', 'actions', 'trigger', 'triggerBody', 'triggerOutputs', 'workflow', 'parameters',
    'variables', 'items', 'item', 'iterationIndexes',
    'addToTime', 'subtractFromTime', 'convertFromUtc', 'convertToUtc', 'ticks', 'dayOfWeek', 'dayOfMonth', 'dayOfYear',
    'formatNumber', 'parseDateTime', 'dateDifference',
    'setProperty', 'removeProperty', 'addProperty', 'xpath', 'xml',
    'encodeBase64', 'dataUri', 'dataUriToString', 'dataUriToBinary', 'binary', 'base64ToBinary', 'uriPath', 'uriPathAndQuery', 'uriHost', 'uriPort', 'uriQuery', 'uriScheme',
    'getFutureTime', 'getPastTime', 'convertTimeZone',
    'actionBody', 'actionOutputs',
    'result', 'count', 'Trim'
  ];
  let result = expr;
  // Match @FunctionName( pattern and lowercase known function names
  for (const fn of paFunctions) {
    const regex = new RegExp(`@${fn}\\(`, 'gi');
    result = result.replace(regex, `@${fn.toLowerCase()}(`);
  }
  // Also match nested function calls without @ prefix (after comma or open paren)
  for (const fn of paFunctions) {
    const regex = new RegExp(`([,\\(])\\s*${fn}\\(`, 'gi');
    result = result.replace(regex, (match, prefix) => `${prefix}${fn.toLowerCase()}(`);
  }
  return result;
}

/**
 * Normalize number formatting within a string.
 * 100.00 -> 100, 3.50 -> 3.5, 1.10 -> 1.1
 * Handles numbers embedded in strings like OData filters.
 */
function normalizeNumbersInString(str: string): string {
  // Match numbers with trailing zeros after decimal point
  // Examples: 100.00 -> 100, 3.50 -> 3.5, -1.10 -> -1.1
  return str.replace(/(-?\d+)\.(\d*?)0+(?=\s|$|[,)'"\]}])/g, (match, intPart, decPart) => {
    // If decimal part is all zeros, return just the integer
    if (!decPart || decPart === '') {
      return intPart;
    }
    // Otherwise return with cleaned decimal (e.g., 3.50 -> 3.5)
    return `${intPart}.${decPart}`;
  });
}

/**
 * Normalize number formatting - convert numbers with trailing zeros to clean format.
 * 100.00 -> 100, 3.50 -> 3.5, 1.10 -> 1.1, "10" -> 10
 * Also normalizes numbers embedded in strings (OData filters, etc.)
 */
function normalizeNumbers(obj: any): any {
  if (typeof obj === 'number') {
    return obj;
  }
  if (typeof obj === 'string') {
    // Check if it's a pure integer string (e.g., "10" -> 10)
    if (/^-?\d+$/.test(obj)) {
      return parseInt(obj, 10);
    }
    // Check if it's a pure number string with trailing zeros
    if (/^-?\d+\.0+$/.test(obj)) {
      // "100.00" -> 100 (integer)
      return parseInt(obj, 10);
    }
    if (/^-?\d+\.\d*0+$/.test(obj) && !obj.endsWith('.')) {
      // "3.50" -> 3.5
      const num = parseFloat(obj);
      if (!isNaN(num) && num.toString() !== obj) {
        return num;
      }
    }
    // For mixed strings, normalize numbers within the string
    return normalizeNumbersInString(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeNumbers);
  }
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const key of Object.keys(obj)) {
      result[key] = normalizeNumbers(obj[key]);
    }
    return result;
  }
  return obj;
}

/**
 * Normalize multiple consecutive spaces to single space.
 */
function normalizeMultipleSpaces(str: string): string {
  return str.replace(/  +/g, ' ');
}

/**
 * Normalize type names to lowercase (String -> string, Boolean -> boolean, etc.)
 * Power Automate type names are case-insensitive.
 */
function normalizeTypeCase(obj: any): any {
  if (typeof obj === 'string') {
    // Normalize common type names
    const typeMap: Record<string, string> = {
      'String': 'string',
      'Boolean': 'boolean',
      'Integer': 'integer',
      'Float': 'float',
      'Number': 'number',
      'Array': 'array',
      'Object': 'object',
    };
    return typeMap[obj] || obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeTypeCase);
  }
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const key of Object.keys(obj)) {
      result[key] = normalizeTypeCase(obj[key]);
    }
    return result;
  }
  return obj;
}

/**
 * Normalize item()/items('LoopName') references in expressions.
 * items('LoopName') is the explicit form of item() — both are equivalent in PA.
 * The DSL always expands item() to items('LoopName') for semantic correctness.
 */
function normalizeItemFunction(expr: string): string {
  // Replace items('...') with item() — handles any single-quoted loop name
  return expr.replace(/\bitems\('[^']*'\)/g, 'item()');
}

function normalizeExpressionsInObject(o: any, parityConfig: Required<ParityConfig>): any {
  if (typeof o === 'string') {
    let result = o;
    // Normalize strings that contain Power Automate expressions
    // Expressions can start with @ or be embedded as @{...} anywhere in the string
    if (o.includes('@')) {
      result = normalizeExpressionWhitespace(result);
      if (parityConfig.normalizeFunctionCase) {
        result = normalizeFunctionCase(result);
      }
      if (parityConfig.normalizeItemFunction) {
        result = normalizeItemFunction(result);
      }
    }
    // Normalize multiple spaces (applies to all strings, not just expressions)
    if (parityConfig.normalizeSpaces) {
      result = normalizeMultipleSpaces(result);
    }
    return result;
  }
  if (Array.isArray(o)) {
    return o.map(item => normalizeExpressionsInObject(item, parityConfig));
  }
  if (o && typeof o === 'object') {
    const result: any = {};
    for (const key of Object.keys(o)) {
      result[key] = normalizeExpressionsInObject(o[key], parityConfig);
    }
    return result;
  }
  return o;
}

/**
 * Normalize connector action parameters by unflattening "/" keys to nested objects.
 * Power Automate treats item/field: val and item: { field: val } as equivalent.
 * The DSL round-trip may change between these formats, so normalize both sides.
 */
function unflattenParameterKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(unflattenParameterKeys);
  if (obj && typeof obj === 'object') {
    // Check if this object has "/" keys that should be unflattened
    const hasSlashKeys = Object.keys(obj).some(k => k.includes('/'));
    if (hasSlashKeys) {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key.includes('/')) {
          // Only unflatten if the value is a primitive or expression (not an object/array)
          // Object values at "/" keys are data that should be preserved as-is
          if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
            result[key] = unflattenParameterKeys(value);
            continue;
          }
          const parts = key.split('/');
          let current = result;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!(parts[i] in current) || typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
              current[parts[i]] = {};
            }
            current = current[parts[i]];
          }
          current[parts[parts.length - 1]] = unflattenParameterKeys(value);
        } else {
          result[key] = unflattenParameterKeys(value);
        }
      }
      return result;
    }
    // No slash keys - just recurse into values
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = unflattenParameterKeys(value);
    }
    return result;
  }
  return obj;
}

function findSemanticDiffs(original: any, output: any, path: string = ''): SemanticDiff[] {
  const diffs: SemanticDiff[] = [];

  // Handle null/undefined
  if (original === null || original === undefined) {
    if (output !== null && output !== undefined) {
      diffs.push({ path: path || '$', type: 'extra_in_output', outputValue: output });
    }
    return diffs;
  }
  if (output === null || output === undefined) {
    diffs.push({ path: path || '$', type: 'missing_in_output', originalValue: original });
    return diffs;
  }

  // Type mismatch
  const origType = Array.isArray(original) ? 'array' : typeof original;
  const outType = Array.isArray(output) ? 'array' : typeof output;
  if (origType !== outType) {
    diffs.push({ path: path || '$', type: 'type_mismatch', originalValue: original, outputValue: output });
    return diffs;
  }

  // Arrays
  if (Array.isArray(original)) {
    const maxLen = Math.max(original.length, output.length);
    for (let i = 0; i < maxLen; i++) {
      const elemPath = `${path}[${i}]`;
      if (i >= original.length) {
        diffs.push({ path: elemPath, type: 'extra_in_output', outputValue: output[i] });
      } else if (i >= output.length) {
        diffs.push({ path: elemPath, type: 'missing_in_output', originalValue: original[i] });
      } else {
        diffs.push(...findSemanticDiffs(original[i], output[i], elemPath));
      }
    }
    return diffs;
  }

  // Objects
  if (typeof original === 'object') {
    const allKeys = new Set([...Object.keys(original), ...Object.keys(output)]);
    for (const key of allKeys) {
      const keyPath = path ? `${path}.${key}` : key;
      if (!(key in original)) {
        diffs.push({ path: keyPath, type: 'extra_in_output', outputValue: output[key] });
      } else if (!(key in output)) {
        diffs.push({ path: keyPath, type: 'missing_in_output', originalValue: original[key] });
      } else {
        diffs.push(...findSemanticDiffs(original[key], output[key], keyPath));
      }
    }
    return diffs;
  }

  // Primitives
  if (original !== output) {
    diffs.push({ path: path || '$', type: 'value_mismatch', originalValue: original, outputValue: output });
  }

  return diffs;
}

/**
 * Categorize a set of semantic diffs by the kind of field that differs, so the
 * CLI can surface a single hint about what drove the mismatch.
 */
function categorizeByPath(diffs: SemanticDiff[]): string {
  if (diffs.some(d => d.path.includes('.metadata') || d.path.endsWith('metadata'))) {
    return 'metadata';
  }
  if (diffs.some(d => d.path.includes('staticResults'))) {
    return 'staticResults';
  }
  if (diffs.some(d => d.path.includes('triggerAuthenticationType'))) {
    return 'triggerAuthenticationType';
  }
  if (diffs.some(d => d.path.includes('.description') || d.path.endsWith('description'))) {
    return 'description';
  }
  if (diffs.some(d => d.path.includes('headersSchema'))) {
    return 'headersSchema';
  }
  if (diffs.some(d => d.path.includes('retryPolicy'))) {
    return 'retry-policy';
  }
  if (diffs.some(d => d.path.includes('runtimeConfiguration'))) {
    return 'runtimeConfiguration';
  }
  if (diffs.some(d => d.path.includes('.expression') && d.type === 'value_mismatch')) {
    return 'expression';
  }
  if (diffs.some(d => d.path.includes('.outputs') || d.path.endsWith('outputs'))) {
    return 'outputs';
  }
  if (diffs.some(d => d.path.includes('.runAfter'))) {
    return 'run-after';
  }
  return 'unknown';
}

/**
 * Run the parity round-trip on Logic Apps JSON and report semantic differences.
 *
 * Pipeline: Logic Apps JSON → IR → DSL → IR → Logic Apps JSON, then normalize
 * both the input and re-emitted definitions and compare them semantically.
 *
 * @throws {ParityTransformError} when the generated DSL fails to transform back to IR.
 */
export function checkParity(json: any, opts: { flowName?: string; config: FlowForgerConfig }): ParityResult {
  const { flowName, config } = opts;

  // Extract definition consistently from both input formats:
  // Format 1: { properties: { definition: {...} } } (Dataverse format)
  // Format 2: { definition: {...} } (standalone format)
  // Format 3: {...} (bare definition)
  const inputDefinition = json.properties?.definition || json.definition || json;

  // Step 1: Parse Logic Apps JSON to IR (using config for parser options)
  const irFromLogicApps = parseLogicAppsToIR(json, { flowName, config });

  // Step 2: Generate DSL from IR (using config for expression handling)
  const nativeDslCode = generateNativeDslFromIR(irFromLogicApps, { flowName, config });

  // Step 3: Reset ID counter to ensure consistent IDs
  resetIdCounter();

  // Step 4: Transform the generated native DSL back to IR
  let ir: FlowIR;
  try {
    ir = transformCode(nativeDslCode);
  } catch (err) {
    throw new ParityTransformError(err);
  }

  // Emit the IR back to Logic Apps JSON.
  // The parser drops the default `@parameters('$authentication')` so it's not noise on the IR;
  // the emitter re-injects it (via the default includeAuthentication=true) to match Power
  // Automate output conventions. Non-default auth (Raw/OAuth/etc.) is preserved on the IR
  // explicitly and emitted as-is.
  const emitted = emitLogicAppsJson(ir);
  const outputDefinition = emitted.properties.definition;

  // Remove ignored fields before comparison
  let actualNormalized = removeIgnoredFields(inputDefinition);
  let expectedNormalized = removeIgnoredFields(outputDefinition);

  // Get parity config with defaults
  const parityConfig: Required<ParityConfig> = {
    ...DEFAULT_PARITY_CONFIG,
    ...config.parity,
  };

  // Apply number normalization (converts 100.00 -> 100, etc.)
  if (parityConfig.normalizeNumbers) {
    actualNormalized = normalizeNumbers(actualNormalized);
    expectedNormalized = normalizeNumbers(expectedNormalized);
  }

  // Normalize type names (String -> string, Boolean -> boolean, etc.)
  actualNormalized = normalizeTypeCase(actualNormalized);
  expectedNormalized = normalizeTypeCase(expectedNormalized);

  // Normalize expression whitespace and function case for comparison (in-memory only)
  actualNormalized = normalizeExpressionsInObject(actualNormalized, parityConfig);
  expectedNormalized = normalizeExpressionsInObject(expectedNormalized, parityConfig);

  // Normalize parameter flattening (item/field: val ↔ item: { field: val })
  actualNormalized = unflattenParameterKeys(actualNormalized);
  expectedNormalized = unflattenParameterKeys(expectedNormalized);

  // Find semantic differences
  const semanticDiffs = findSemanticDiffs(actualNormalized, expectedNormalized);
  if (semanticDiffs.length === 0) {
    return { ok: true };
  }

  const category = categorizeByPath(semanticDiffs);

  // Format differences for output (limit to first 10)
  const formatValue = (v: any) => {
    if (v === undefined) return '(undefined)';
    if (v === null) return 'null';
    const str = JSON.stringify(v);
    return str.length > 80 ? str.substring(0, 77) + '...' : str;
  };
  const differences: ParityDifference[] = semanticDiffs.slice(0, 10).map(d => ({
    path: d.path,
    type: d.type,
    original: d.type === 'extra_in_output' ? '(not present)' : formatValue(d.originalValue),
    output: d.type === 'missing_in_output' ? '(not present)' : formatValue(d.outputValue),
  }));

  return {
    ok: false,
    category,
    totalDiffs: semanticDiffs.length,
    differences,
  };
}
