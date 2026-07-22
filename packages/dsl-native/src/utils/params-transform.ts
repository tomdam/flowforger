/**
 * Params Transform Utilities
 * Functions for flattening and unflattening connector action parameters.
 *
 * Power Automate expects parameters in a flattened format with "/" separators:
 *   { "item/name": "x", "item/value": "y", entityName: "z" }
 *
 * But for better DX, the DSL allows nested objects:
 *   { item: { name: "x", value: "y" }, entityName: "z" }
 *
 * These utilities convert between the two formats.
 */

/**
 * Flatten nested objects in params to "parent/child" format.
 * Converts: { item: { name: "x" }, entityName: "z" }
 * To:       { "item/name": "x", entityName: "z" }
 *
 * Handles multi-level nesting: { a: { b: { c: "x" } } } -> { "a/b/c": "x" }
 *
 * Only flattens plain objects - arrays and primitive values are preserved as-is.
 * Keys that already contain "/" are preserved as-is (their values are not flattened),
 * since they represent flat connector parameter paths whose values should be kept intact.
 */
export function flattenParams(params: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};

  function flatten(obj: Record<string, any>, prefix: string): void {
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}/${key}` : key;

      // If the key already contains "/", it's a pre-existing flat connector param path
      // (e.g., 'parameters/headers': {object}). Preserve its value as-is.
      if (key.includes('/')) {
        result[newKey] = value;
      } else if (key.startsWith('__')) {
        // Keys starting with __ are internal metadata markers (e.g., __legacyApiConnection,
        // __legacyApiConnectionWebhook) that must be preserved as nested objects.
        result[newKey] = value;
      } else if (isPlainObjectToFlatten(value)) {
        // Check if value is a plain object that should be flattened
        flatten(value, newKey);
      } else {
        result[newKey] = value;
      }
    }
  }

  flatten(params, '');
  return result;
}

/**
 * Unflatten params with "/" separators back to nested objects.
 * Converts: { "item/name": "x", entityName: "z" }
 * To:       { item: { name: "x" }, entityName: "z" }
 *
 * Handles multi-level: { "a/b/c": "x" } -> { a: { b: { c: "x" } } }
 *
 * Keys whose values are non-null, non-array objects are kept as flat keys,
 * since the object value is data (e.g., HTTP headers) not a parameter path.
 */
export function unflattenParams(params: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(params)) {
    if (key.includes('/')) {
      // If the value is an object (not null, not array), keep the key as-is.
      // Object values at "/" keys represent data (e.g., parameters/headers: {Accept: "json"})
      // that should be preserved, not unflattened further.
      if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = value;
        continue;
      }

      // Split on "/" and create nested structure
      const parts = key.split('/');
      let current = result;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!(part in current)) {
          current[part] = {};
        } else if (typeof current[part] !== 'object' || current[part] === null || Array.isArray(current[part])) {
          // If there's a conflict (e.g., both "item" and "item/name" exist), keep it flattened
          // This handles edge cases where the structure can't be cleanly unflattened
          current = result;
          result[key] = value;
          break;
        }
        current = current[part];
      }

      // Set the final value if we successfully navigated
      if (current !== result || !(key in result)) {
        current[parts[parts.length - 1]] = value;
      }
    } else {
      // No "/" - keep as-is, but handle potential conflicts with nested keys
      if (key in result && typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
        // There's already a nested object here from a "key/subkey" - merge if possible
        // For now, the nested object takes precedence
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Check if a value is a plain object that should be flattened.
 * Returns false for:
 * - null
 * - arrays
 * - primitive values
 * - objects that look like Power Automate expressions or special structures
 * - objects that look like data (e.g., HTTP headers) rather than connector parameter paths
 */
function isPlainObjectToFlatten(value: any): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return false;
  }

  // Don't flatten empty objects - they might be intentional
  if (Object.keys(value).length === 0) {
    return false;
  }

  // Don't flatten objects that have special keys indicating they shouldn't be flattened
  // 'type' catches parameter/schema definitions like { type: "String", defaultValue: "..." }
  // '__legacyApiConnection' catches legacy format markers
  // Note: 'value' is intentionally NOT here — { value: "x" } is a valid field assignment
  // that should be flattened (e.g., item/Status/Value)
  const specialKeys = ['type', '__legacyApiConnection'];
  for (const key of specialKeys) {
    if (key in value) {
      return false;
    }
  }

  for (const [key, val] of Object.entries(value)) {
    // Don't flatten objects whose keys contain dashes (but not negative numbers).
    // Dashes in keys indicate data objects like HTTP headers (Content-Type, X-Custom-Header).
    // Connector parameter path segments never use dashes.
    if (key.includes('-') && !/^-?\d+$/.test(key)) {
      return false;
    }

    // Don't flatten objects with expression-style keys (e.g., @triggerBody()?['field'])
    // These indicate dynamic data objects, not connector parameter paths.
    if (key.startsWith('@')) {
      return false;
    }

    // Don't flatten if a child object is itself non-flattenable.
    // This prevents partial flattening like body/activity: {object} when the original
    // was body: { activity: {object} }. Flattening should only happen when the entire
    // structure can be fully flattened down to scalar leaves.
    if (val !== null && typeof val === 'object' && !Array.isArray(val) &&
        Object.keys(val).length > 0 && !isPlainObjectToFlatten(val)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if params need flattening (contain nested objects that should be flattened).
 */
export function needsFlattening(params: Record<string, any>): boolean {
  for (const value of Object.values(params)) {
    if (isPlainObjectToFlatten(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if params need unflattening (contain "/" in keys).
 */
export function needsUnflattening(params: Record<string, any>): boolean {
  for (const key of Object.keys(params)) {
    if (key.includes('/')) {
      return true;
    }
  }
  return false;
}
