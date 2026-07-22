/**
 * IR Diff Engine
 *
 * Compares two FlowIR objects and produces a structured FlowDiff showing
 * added/removed/changed/moved nodes with property-level and expression-level detail.
 */

import type {
  FlowIR,
  Node,
  ScopeNode,
  IfNode,
  ForeachNode,
  SwitchNode,
  DoUntilNode,
} from './index.js';

import type { ParityConfig } from './config.js';
import { DEFAULT_PARITY_CONFIG } from './config.js';

// Inline type guards to avoid circular dependency with index.ts
function isScope(n: Node): n is ScopeNode { return n.type === 'scope'; }
function isIf(n: Node): n is IfNode { return n.type === 'if'; }
function isForeach(n: Node): n is ForeachNode { return n.type === 'foreach'; }
function isSwitch(n: Node): n is SwitchNode { return n.type === 'switch'; }
function isDoUntil(n: Node): n is DoUntilNode { return n.type === 'dountil'; }

// ============================================================================
// Types
// ============================================================================

/**
 * Options for controlling diff behavior.
 */
export interface DiffOptions {
  /** Parity config for normalization (reuses existing ParityConfig type) */
  parity?: ParityConfig;
  /** Whether to ignore metadata field differences (default: true) */
  ignoreMetadata?: boolean;
  /** Whether to ignore staticResults differences (default: true) */
  ignoreStaticResults?: boolean;
  /** Similarity threshold for fuzzy matching (0-1, default: 0.5) */
  fuzzyMatchThreshold?: number;
}

/**
 * A change within an expression string.
 */
export interface ExpressionChange {
  /** Type of change */
  type: 'function_renamed' | 'argument_changed' | 'expression_rewritten';
  /** Path within the expression (e.g., function name) */
  path?: string;
  /** Old value */
  oldValue: string;
  /** New value */
  newValue: string;
}

/**
 * Diff of two expression strings.
 */
export interface ExpressionDiff {
  /** Full old expression */
  oldExpression: string;
  /** Full new expression */
  newExpression: string;
  /** Detailed changes within the expression */
  changes: ExpressionChange[];
}

/**
 * Diff of a single property on a node.
 */
export interface PropertyDiff {
  /** Property path (dot-separated, e.g., "inputs.method") */
  path: string;
  /** Old value (undefined if added) */
  oldValue?: any;
  /** New value (undefined if removed) */
  newValue?: any;
  /** If both values are expressions, detailed expression diff */
  expressionDiff?: ExpressionDiff;
}

/**
 * Status of a node in the diff.
 */
export type NodeDiffStatus = 'unchanged' | 'added' | 'removed' | 'changed';

/**
 * Diff result for a single node.
 */
export interface NodeDiff {
  /** Status of this node */
  status: NodeDiffStatus;
  /** Node name */
  name: string;
  /** Node type */
  nodeType: string;
  /** Whether the node was moved (different index or parent) - orthogonal to status */
  moved: boolean;
  /** Old index in parent array (undefined if added) */
  oldIndex?: number;
  /** New index in parent array (undefined if removed) */
  newIndex?: number;
  /** Parent path (e.g., "root", "Scope1.actions", "If1.elseActions") */
  parentPath: string;
  /** Old parent path if moved */
  oldParentPath?: string;
  /** Property-level diffs (only for status === 'changed') */
  propertyDiffs: PropertyDiff[];
  /** Child diffs for control nodes (scope, if, foreach, switch, dountil) */
  childDiffs?: NodeDiff[];
  /** The old node (undefined if added) */
  oldNode?: Node;
  /** The new node (undefined if removed) */
  newNode?: Node;
  /** Fuzzy match similarity score (0-1, only set for fuzzy-matched nodes) */
  similarityScore?: number;
}

/**
 * Diff of a flow-level field (name, description, parameters, etc.).
 */
export interface FlowFieldDiff {
  /** Field name */
  field: string;
  /** Old value */
  oldValue?: any;
  /** New value */
  newValue?: any;
}

/**
 * Summary counts for a diff.
 */
export interface DiffSummary {
  /** Total nodes compared */
  totalNodes: number;
  /** Number of unchanged nodes */
  unchanged: number;
  /** Number of added nodes */
  added: number;
  /** Number of removed nodes */
  removed: number;
  /** Number of changed nodes */
  changed: number;
  /** Number of moved nodes (orthogonal to other statuses) */
  moved: number;
  /** Number of flow-level field changes */
  flowFieldChanges: number;
}

/**
 * Complete diff result for two FlowIR objects.
 */
export interface FlowDiff {
  /** Flow-level field diffs (name, description, parameters, connectionReferences, etc.) */
  flowFieldDiffs: FlowFieldDiff[];
  /** Node-level diffs */
  nodeDiffs: NodeDiff[];
  /** Summary counts */
  summary: DiffSummary;
}

// ============================================================================
// Normalization Helpers
// ============================================================================

/**
 * Normalize a value according to parity config before comparison.
 */
function normalizeValue(value: any, config: Required<ParityConfig>): any {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    let result = value;
    if (config.ignoreWhitespace) {
      result = result.replace(/\s+/g, ' ').trim();
    }
    if (config.ignoreTrailingWhitespace) {
      result = result.replace(/\s+$/gm, '');
    }
    if (config.normalizeSpaces) {
      result = result.replace(/ {2,}/g, ' ');
    }
    if (config.normalizeFunctionCase && result.startsWith('@')) {
      result = normalizeFunctionCaseInExpression(result);
    }
    return result;
  }

  if (typeof value === 'number' && config.normalizeNumbers) {
    // Normalize number: 100.00 → 100
    return parseFloat(String(value));
  }

  if (Array.isArray(value)) {
    return value.map(v => normalizeValue(v, config));
  }

  if (typeof value === 'object') {
    const normalized: Record<string, any> = {};
    const keys = config.ignoreKeyOrder
      ? Object.keys(value).sort()
      : Object.keys(value);
    for (const key of keys) {
      normalized[key] = normalizeValue(value[key], config);
    }
    return normalized;
  }

  return value;
}

/**
 * Known Power Automate function names (lowercase) for case normalization.
 */
const PA_FUNCTIONS = new Set([
  'concat', 'substring', 'replace', 'tolower', 'toupper', 'trim', 'split', 'join',
  'indexof', 'lastindexof', 'guid', 'base64', 'base64tostring', 'uricomponent',
  'uricomponenttostring', 'startswith', 'endswith', 'contains', 'length', 'empty',
  'first', 'last', 'skip', 'take', 'union', 'intersection', 'createarray', 'range',
  'equals', 'greater', 'less', 'greaterorequals', 'lessorequals',
  'and', 'or', 'not', 'if', 'coalesce',
  'int', 'float', 'abs', 'ceil', 'floor', 'round', 'add', 'sub', 'mul', 'div', 'mod', 'min', 'max', 'rand',
  'utcnow', 'adddays', 'addhours', 'addminutes', 'formatdatetime',
  'json', 'string', 'bool', 'array',
  'actions', 'body', 'outputs', 'trigger', 'triggerbody', 'triggeroutputs',
  'workflow', 'parameters', 'variables', 'items',
  'null', 'true', 'false',
  'formatnumber', 'decimal', 'binary', 'datadifference', 'addtottime',
  'addseconds', 'ticks', 'converttimezone', 'dayofweek', 'dayofmonth', 'dayofyear',
  'nthindexof', 'chunk', 'sort', 'reverse', 'setproperty', 'removeproperty',
  'xpath', 'xml', 'encode', 'decode',
]);

/**
 * Normalize function name casing in an expression string.
 * Converts known PA function names to lowercase.
 */
function normalizeFunctionCaseInExpression(expr: string): string {
  // Match word characters followed by '(' - these are function calls
  return expr.replace(/\b([a-zA-Z_]\w*)\s*\(/g, (match, funcName) => {
    const lower = funcName.toLowerCase();
    if (PA_FUNCTIONS.has(lower)) {
      return lower + '(';
    }
    return match;
  });
}

/**
 * Normalize a node's properties for comparison.
 * Strips metadata, normalizes runAfter, etc.
 */
function normalizeNodeForComparison(
  node: Node,
  config: Required<ParityConfig>,
  ignoreMetadata: boolean
): Record<string, any> {
  const obj: Record<string, any> = { ...node };

  // Remove structural keys that are handled separately
  delete obj.id;
  if (isScope(node)) delete obj.actions;
  if (isIf(node)) { delete obj.actions; delete obj.elseActions; }
  if (isForeach(node)) delete obj.actions;
  if (isSwitch(node)) { delete obj.cases; delete obj.defaultActions; }
  if (isDoUntil(node)) delete obj.actions;

  // Handle metadata
  if (ignoreMetadata) {
    delete obj.metadata;
  }

  // Handle empty runAfter
  if (config.ignoreEmptyRunAfter && obj.runAfter) {
    if (typeof obj.runAfter === 'object' && Object.keys(obj.runAfter).length === 0) {
      delete obj.runAfter;
    }
  }

  // Normalize all values
  return normalizeValue(obj, config);
}

// ============================================================================
// Node Matching
// ============================================================================

interface NodeWithIndex {
  node: Node;
  index: number;
  parentPath: string;
}

/**
 * Build a flat map of node name → NodeWithIndex for exact matching.
 */
/**
 * Calculate Jaccard similarity between two sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersectionSize = 0;
  for (const item of a) {
    if (b.has(item)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 1 : intersectionSize / unionSize;
}

/**
 * Get flat property keys from a node (for similarity comparison).
 */
function getPropertyKeys(node: Node): Set<string> {
  const keys = new Set<string>();
  function addKeys(obj: any, prefix: string) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        keys.add(fullKey);
        addKeys(obj[key], fullKey);
      }
    }
  }
  addKeys(node, '');
  return keys;
}

/**
 * Simple string distance metric (normalized).
 * Uses a quick character frequency comparison for performance.
 * Returns 0 (identical) to 1 (completely different).
 */
function normalizedStringDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0 || b.length === 0) return 1;

  // Cap at 500 chars for performance
  const sa = a.length > 500 ? a.substring(0, 500) : a;
  const sb = b.length > 500 ? b.substring(0, 500) : b;

  // Character frequency comparison
  const freqA = new Map<string, number>();
  const freqB = new Map<string, number>();
  for (const ch of sa) freqA.set(ch, (freqA.get(ch) || 0) + 1);
  for (const ch of sb) freqB.set(ch, (freqB.get(ch) || 0) + 1);

  const allChars = new Set([...freqA.keys(), ...freqB.keys()]);
  let diffSum = 0;
  let totalSum = 0;
  for (const ch of allChars) {
    const countA = freqA.get(ch) || 0;
    const countB = freqB.get(ch) || 0;
    diffSum += Math.abs(countA - countB);
    totalSum += Math.max(countA, countB);
  }

  return totalSum === 0 ? 0 : diffSum / totalSum;
}

/**
 * Calculate similarity between two nodes using a weighted metric.
 * Returns a value between 0 (completely different) and 1 (identical).
 *
 * Weights:
 * - Type match: 0.3
 * - Parameter key overlap (Jaccard): 0.3
 * - Expression/content similarity: 0.2
 * - Structural position: 0.1
 * - Name similarity: 0.1
 */
function calculateNodeSimilarity(
  oldNode: NodeWithIndex,
  newNode: NodeWithIndex,
  oldTotal: number,
  newTotal: number
): number {
  let score = 0;

  // Type match (0.3)
  if (oldNode.node.type === newNode.node.type) {
    score += 0.3;
    // Also check kind for action nodes
    if ('kind' in oldNode.node && 'kind' in newNode.node) {
      if ((oldNode.node as any).kind === (newNode.node as any).kind) {
        score += 0; // Already counted in type match
      }
    }
  }

  // Property key overlap (0.3)
  const oldKeys = getPropertyKeys(oldNode.node);
  const newKeys = getPropertyKeys(newNode.node);
  score += 0.3 * jaccardSimilarity(oldKeys, newKeys);

  // Content similarity via string distance (0.2)
  const oldJson = JSON.stringify(oldNode.node);
  const newJson = JSON.stringify(newNode.node);
  score += 0.2 * (1 - normalizedStringDistance(oldJson, newJson));

  // Structural position (0.1)
  const oldPos = oldTotal > 1 ? oldNode.index / (oldTotal - 1) : 0;
  const newPos = newTotal > 1 ? newNode.index / (newTotal - 1) : 0;
  score += 0.1 * (1 - Math.abs(oldPos - newPos));

  // Name similarity (0.1)
  score += 0.1 * (1 - normalizedStringDistance(oldNode.node.name, newNode.node.name));

  return score;
}

/**
 * Match nodes between two arrays using exact name match first, then fuzzy matching.
 * Returns matched pairs and unmatched nodes from each side.
 */
function matchNodes(
  oldNodes: Node[],
  newNodes: Node[],
  parentPath: string,
  threshold: number
): {
  matched: Array<{ old: NodeWithIndex; new: NodeWithIndex; similarity: number }>;
  unmatchedOld: NodeWithIndex[];
  unmatchedNew: NodeWithIndex[];
} {
  const oldWithIndex: NodeWithIndex[] = oldNodes.map((node, index) => ({ node, index, parentPath }));
  const newWithIndex: NodeWithIndex[] = newNodes.map((node, index) => ({ node, index, parentPath }));

  const matched: Array<{ old: NodeWithIndex; new: NodeWithIndex; similarity: number }> = [];
  const matchedOldIndices = new Set<number>();
  const matchedNewIndices = new Set<number>();

  // Phase 1: Exact name matching
  const newByName = new Map<string, number>();
  for (let i = 0; i < newWithIndex.length; i++) {
    // Only store first occurrence for exact match
    if (!newByName.has(newWithIndex[i].node.name)) {
      newByName.set(newWithIndex[i].node.name, i);
    }
  }

  for (let oi = 0; oi < oldWithIndex.length; oi++) {
    const ni = newByName.get(oldWithIndex[oi].node.name);
    if (ni !== undefined && !matchedNewIndices.has(ni)) {
      matched.push({ old: oldWithIndex[oi], new: newWithIndex[ni], similarity: 1.0 });
      matchedOldIndices.add(oi);
      matchedNewIndices.add(ni);
    }
  }

  // Phase 2: Fuzzy matching for remaining unmatched nodes
  const remainingOld = oldWithIndex.filter((_, i) => !matchedOldIndices.has(i));
  const remainingNew = newWithIndex.filter((_, i) => !matchedNewIndices.has(i));

  if (remainingOld.length > 0 && remainingNew.length > 0) {
    // Build similarity matrix
    const similarities: Array<{ oi: number; ni: number; score: number }> = [];
    for (let oi = 0; oi < remainingOld.length; oi++) {
      for (let ni = 0; ni < remainingNew.length; ni++) {
        const score = calculateNodeSimilarity(
          remainingOld[oi],
          remainingNew[ni],
          oldNodes.length,
          newNodes.length
        );
        if (score >= threshold) {
          similarities.push({ oi, ni, score });
        }
      }
    }

    // Greedy matching: pick highest similarity pairs first
    similarities.sort((a, b) => b.score - a.score);
    const usedOld = new Set<number>();
    const usedNew = new Set<number>();

    for (const { oi, ni, score } of similarities) {
      if (!usedOld.has(oi) && !usedNew.has(ni)) {
        matched.push({ old: remainingOld[oi], new: remainingNew[ni], similarity: score });
        usedOld.add(oi);
        usedNew.add(ni);
      }
    }

    const unmatchedOld = remainingOld.filter((_, i) => !usedOld.has(i));
    const unmatchedNew = remainingNew.filter((_, i) => !usedNew.has(i));

    return { matched, unmatchedOld, unmatchedNew };
  }

  return {
    matched,
    unmatchedOld: remainingOld.length > 0 ? remainingOld : [],
    unmatchedNew: remainingNew.length > 0 ? remainingNew : [],
  };
}

// ============================================================================
// Expression Diffing
// ============================================================================

/**
 * Check if a string value looks like a Power Automate expression.
 */
function isExpression(value: any): value is string {
  return typeof value === 'string' && value.startsWith('@');
}

/**
 * Extract function name and arguments from a simple expression like @func(args).
 */
function parseSimpleExpression(expr: string): { funcName: string; args: string } | null {
  const match = expr.match(/^@(\w+)\((.*)?\)$/s);
  if (match) {
    return { funcName: match[1], args: match[2] || '' };
  }
  return null;
}

/**
 * Diff two expression strings.
 */
function diffExpressions(oldExpr: string, newExpr: string): ExpressionDiff {
  const changes: ExpressionChange[] = [];

  const oldParsed = parseSimpleExpression(oldExpr);
  const newParsed = parseSimpleExpression(newExpr);

  if (oldParsed && newParsed) {
    // Both are simple function calls
    if (oldParsed.funcName.toLowerCase() !== newParsed.funcName.toLowerCase()) {
      changes.push({
        type: 'function_renamed',
        path: oldParsed.funcName,
        oldValue: oldParsed.funcName,
        newValue: newParsed.funcName,
      });
    }
    if (oldParsed.args !== newParsed.args) {
      changes.push({
        type: 'argument_changed',
        path: (oldParsed.funcName === newParsed.funcName ? newParsed.funcName : `${oldParsed.funcName}→${newParsed.funcName}`),
        oldValue: oldParsed.args,
        newValue: newParsed.args,
      });
    }
  } else {
    // Complex or different format
    changes.push({
      type: 'expression_rewritten',
      oldValue: oldExpr,
      newValue: newExpr,
    });
  }

  return {
    oldExpression: oldExpr,
    newExpression: newExpr,
    changes,
  };
}

// ============================================================================
// Property Diffing
// ============================================================================

/**
 * Deep compare two values with normalization.
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'number') {
    return a === b;
  }

  if (typeof a === 'string') {
    return a === b;
  }

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => deepEqual(a[key], b[key]));
  }

  return false;
}

/**
 * Compute property-level diffs between two normalized node objects.
 */
function diffProperties(
  oldObj: Record<string, any>,
  newObj: Record<string, any>,
  prefix: string = ''
): PropertyDiff[] {
  const diffs: PropertyDiff[] = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldObj[key];
    const newVal = newObj[key];

    if (!(key in oldObj)) {
      // Added property
      diffs.push({ path, newValue: newVal });
    } else if (!(key in newObj)) {
      // Removed property
      diffs.push({ path, oldValue: oldVal });
    } else if (!deepEqual(oldVal, newVal)) {
      // Changed property
      const diff: PropertyDiff = { path, oldValue: oldVal, newValue: newVal };

      // Check for expression diff
      if (isExpression(oldVal) && isExpression(newVal)) {
        diff.expressionDiff = diffExpressions(oldVal, newVal);
      }

      diffs.push(diff);
    }
  }

  return diffs;
}

// ============================================================================
// Recursive Node Diffing
// ============================================================================

/**
 * Get children arrays from a control node for recursive diffing.
 */
function getControlNodeChildren(node: Node): Array<{ path: string; nodes: Node[] }> {
  if (isScope(node)) {
    return [{ path: `${node.name}.actions`, nodes: node.actions }];
  }
  if (isIf(node)) {
    const result: Array<{ path: string; nodes: Node[] }> = [
      { path: `${node.name}.actions`, nodes: node.actions },
    ];
    if (node.elseActions && node.elseActions.length > 0) {
      result.push({ path: `${node.name}.elseActions`, nodes: node.elseActions });
    }
    return result;
  }
  if (isForeach(node)) {
    return [{ path: `${node.name}.actions`, nodes: node.actions }];
  }
  if (isSwitch(node)) {
    const result: Array<{ path: string; nodes: Node[] }> = [];
    for (const c of node.cases) {
      result.push({ path: `${node.name}.cases.${c.name}`, nodes: c.actions });
    }
    if (node.defaultActions && node.defaultActions.length > 0) {
      result.push({ path: `${node.name}.defaultActions`, nodes: node.defaultActions });
    }
    return result;
  }
  if (isDoUntil(node)) {
    return [{ path: `${node.name}.actions`, nodes: node.actions }];
  }
  return [];
}

/**
 * Check if a node is a control node with children.
 */
function isControlNode(node: Node): node is ScopeNode | IfNode | ForeachNode | SwitchNode | DoUntilNode {
  return isScope(node) || isIf(node) || isForeach(node) || isSwitch(node) || isDoUntil(node);
}

/**
 * Diff two arrays of nodes recursively.
 */
function diffNodeArrays(
  oldNodes: Node[],
  newNodes: Node[],
  parentPath: string,
  config: Required<ParityConfig>,
  options: Required<DiffOptions>
): NodeDiff[] {
  const { matched, unmatchedOld, unmatchedNew } = matchNodes(
    oldNodes,
    newNodes,
    parentPath,
    options.fuzzyMatchThreshold
  );

  const diffs: NodeDiff[] = [];

  // Process matched nodes
  for (const { old: oldEntry, new: newEntry, similarity } of matched) {
    const oldNorm = normalizeNodeForComparison(oldEntry.node, config, options.ignoreMetadata);
    const newNorm = normalizeNodeForComparison(newEntry.node, config, options.ignoreMetadata);

    const propertyDiffs = diffProperties(oldNorm, newNorm);
    const moved = oldEntry.index !== newEntry.index || oldEntry.parentPath !== newEntry.parentPath;

    // Recursively diff children of control nodes
    let childDiffs: NodeDiff[] | undefined;
    if (isControlNode(oldEntry.node) && isControlNode(newEntry.node)) {
      childDiffs = diffControlNodeChildren(oldEntry.node, newEntry.node, config, options);
    }

    const hasChildChanges = childDiffs && childDiffs.some(d => d.status !== 'unchanged' || d.moved);

    const status: NodeDiffStatus = propertyDiffs.length > 0 || hasChildChanges ? 'changed' : 'unchanged';

    const diff: NodeDiff = {
      status,
      name: oldEntry.node.name,
      nodeType: oldEntry.node.type,
      moved,
      oldIndex: oldEntry.index,
      newIndex: newEntry.index,
      parentPath,
      propertyDiffs,
      oldNode: oldEntry.node,
      newNode: newEntry.node,
    };

    if (moved && oldEntry.parentPath !== newEntry.parentPath) {
      diff.oldParentPath = oldEntry.parentPath;
    }

    if (childDiffs && childDiffs.length > 0) {
      diff.childDiffs = childDiffs;
    }

    if (similarity < 1.0) {
      diff.similarityScore = similarity;
    }

    diffs.push(diff);
  }

  // Process removed nodes (in old but not matched)
  for (const oldEntry of unmatchedOld) {
    const diff: NodeDiff = {
      status: 'removed',
      name: oldEntry.node.name,
      nodeType: oldEntry.node.type,
      moved: false,
      oldIndex: oldEntry.index,
      parentPath,
      propertyDiffs: [],
      oldNode: oldEntry.node,
    };
    diffs.push(diff);
  }

  // Process added nodes (in new but not matched)
  for (const newEntry of unmatchedNew) {
    const diff: NodeDiff = {
      status: 'added',
      name: newEntry.node.name,
      nodeType: newEntry.node.type,
      moved: false,
      newIndex: newEntry.index,
      parentPath,
      propertyDiffs: [],
      newNode: newEntry.node,
    };
    diffs.push(diff);
  }

  return diffs;
}

/**
 * Diff children of two matched control nodes.
 */
function diffControlNodeChildren(
  oldNode: Node,
  newNode: Node,
  config: Required<ParityConfig>,
  options: Required<DiffOptions>
): NodeDiff[] {
  const allDiffs: NodeDiff[] = [];

  const oldChildren = getControlNodeChildren(oldNode);
  const newChildren = getControlNodeChildren(newNode);

  // Build lookup by path suffix for matching
  const newByPath = new Map<string, { path: string; nodes: Node[] }>();
  for (const child of newChildren) {
    // Use the part after the node name as the matching key
    const pathSuffix = child.path.substring(child.path.indexOf('.') + 1);
    newByPath.set(pathSuffix, child);
  }

  const processedNewPaths = new Set<string>();

  for (const oldChild of oldChildren) {
    const pathSuffix = oldChild.path.substring(oldChild.path.indexOf('.') + 1);
    const newChild = newByPath.get(pathSuffix);

    if (newChild) {
      processedNewPaths.add(pathSuffix);
      const childDiffs = diffNodeArrays(oldChild.nodes, newChild.nodes, newChild.path, config, options);
      allDiffs.push(...childDiffs);
    } else {
      // Old child path has no match in new node — all nodes removed
      for (let i = 0; i < oldChild.nodes.length; i++) {
        allDiffs.push({
          status: 'removed',
          name: oldChild.nodes[i].name,
          nodeType: oldChild.nodes[i].type,
          moved: false,
          oldIndex: i,
          parentPath: oldChild.path,
          propertyDiffs: [],
          oldNode: oldChild.nodes[i],
        });
      }
    }
  }

  // New child paths not in old node — all nodes added
  for (const newChild of newChildren) {
    const pathSuffix = newChild.path.substring(newChild.path.indexOf('.') + 1);
    if (!processedNewPaths.has(pathSuffix)) {
      for (let i = 0; i < newChild.nodes.length; i++) {
        allDiffs.push({
          status: 'added',
          name: newChild.nodes[i].name,
          nodeType: newChild.nodes[i].type,
          moved: false,
          newIndex: i,
          parentPath: newChild.path,
          propertyDiffs: [],
          newNode: newChild.nodes[i],
        });
      }
    }
  }

  return allDiffs;
}

// ============================================================================
// Flow-Level Field Diffing
// ============================================================================

/**
 * Diff flow-level fields (name, description, parameters, connectionReferences, etc.).
 */
function diffFlowFields(
  oldFlow: FlowIR,
  newFlow: FlowIR,
  config: Required<ParityConfig>,
  options: Required<DiffOptions>
): FlowFieldDiff[] {
  const diffs: FlowFieldDiff[] = [];

  // Name
  if (oldFlow.name !== newFlow.name) {
    diffs.push({ field: 'name', oldValue: oldFlow.name, newValue: newFlow.name });
  }

  // Description
  if (oldFlow.description !== newFlow.description) {
    diffs.push({ field: 'description', oldValue: oldFlow.description, newValue: newFlow.description });
  }

  // Parameters
  const oldParams = normalizeValue(oldFlow.parameters, config);
  const newParams = normalizeValue(newFlow.parameters, config);
  if (!deepEqual(oldParams, newParams)) {
    diffs.push({ field: 'parameters', oldValue: oldFlow.parameters, newValue: newFlow.parameters });
  }

  // Connection references
  const oldConnRefs = normalizeValue(oldFlow.connectionReferences, config);
  const newConnRefs = normalizeValue(newFlow.connectionReferences, config);
  if (!deepEqual(oldConnRefs, newConnRefs)) {
    diffs.push({ field: 'connectionReferences', oldValue: oldFlow.connectionReferences, newValue: newFlow.connectionReferences });
  }

  // Child flows
  const oldChildFlows = normalizeValue(oldFlow.childFlows, config);
  const newChildFlows = normalizeValue(newFlow.childFlows, config);
  if (!deepEqual(oldChildFlows, newChildFlows)) {
    diffs.push({ field: 'childFlows', oldValue: oldFlow.childFlows, newValue: newFlow.childFlows });
  }

  // Outputs
  const oldOutputs = normalizeValue(oldFlow.outputs, config);
  const newOutputs = normalizeValue(newFlow.outputs, config);
  if (!deepEqual(oldOutputs, newOutputs)) {
    diffs.push({ field: 'outputs', oldValue: oldFlow.outputs, newValue: newFlow.outputs });
  }

  // Metadata (only if not ignored)
  if (!options.ignoreMetadata) {
    const oldMeta = normalizeValue(oldFlow.metadata, config);
    const newMeta = normalizeValue(newFlow.metadata, config);
    if (!deepEqual(oldMeta, newMeta)) {
      diffs.push({ field: 'metadata', oldValue: oldFlow.metadata, newValue: newFlow.metadata });
    }
  }

  // Static results (only if not ignored)
  if (!options.ignoreStaticResults) {
    const oldStatic = normalizeValue(oldFlow.staticResults, config);
    const newStatic = normalizeValue(newFlow.staticResults, config);
    if (!deepEqual(oldStatic, newStatic)) {
      diffs.push({ field: 'staticResults', oldValue: oldFlow.staticResults, newValue: newFlow.staticResults });
    }
  }

  return diffs;
}

// ============================================================================
// Summary
// ============================================================================

/**
 * Compute summary counts from node diffs (including nested child diffs).
 */
function computeSummary(nodeDiffs: NodeDiff[], flowFieldChanges: number): DiffSummary {
  let totalNodes = 0;
  let unchanged = 0;
  let added = 0;
  let removed = 0;
  let changed = 0;
  let moved = 0;

  function countDiffs(diffs: NodeDiff[]) {
    for (const diff of diffs) {
      totalNodes++;
      switch (diff.status) {
        case 'unchanged': unchanged++; break;
        case 'added': added++; break;
        case 'removed': removed++; break;
        case 'changed': changed++; break;
      }
      if (diff.moved) moved++;
      if (diff.childDiffs) countDiffs(diff.childDiffs);
    }
  }

  countDiffs(nodeDiffs);

  return { totalNodes, unchanged, added, removed, changed, moved, flowFieldChanges };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Diff two FlowIR objects and produce a structured FlowDiff.
 *
 * @param oldFlow - The original/base flow
 * @param newFlow - The new/modified flow
 * @param options - Options controlling diff behavior
 * @returns A FlowDiff with flow-level, node-level, and property-level differences
 */
export function diffFlowIR(
  oldFlow: FlowIR,
  newFlow: FlowIR,
  options?: DiffOptions
): FlowDiff {
  const resolvedOptions: Required<DiffOptions> = {
    parity: options?.parity ?? {},
    ignoreMetadata: options?.ignoreMetadata ?? true,
    ignoreStaticResults: options?.ignoreStaticResults ?? true,
    fuzzyMatchThreshold: options?.fuzzyMatchThreshold ?? 0.5,
  };

  // Merge parity config with defaults
  const parityConfig: Required<ParityConfig> = {
    ...DEFAULT_PARITY_CONFIG,
    ...resolvedOptions.parity,
  };

  // Diff flow-level fields
  const flowFieldDiffs = diffFlowFields(oldFlow, newFlow, parityConfig, resolvedOptions);

  // Diff nodes
  const nodeDiffs = diffNodeArrays(oldFlow.nodes, newFlow.nodes, 'root', parityConfig, resolvedOptions);

  // Compute summary
  const summary = computeSummary(nodeDiffs, flowFieldDiffs.length);

  return { flowFieldDiffs, nodeDiffs, summary };
}
