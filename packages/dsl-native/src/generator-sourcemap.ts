/**
 * DSL Source Map Generator
 *
 * Wraps generateNativeDslFromIR to produce both the DSL code string
 * and a source map that maps node names to the line ranges they occupy.
 */

import type { FlowIR, Node } from '@flowforger/ir';
import { generateNativeDslFromIR, type GeneratorOptions } from './generator.js';

/** A line range in the generated DSL code (1-based, inclusive). */
export interface SourceMapEntry {
  startLine: number; // 1-based
  endLine: number; // 1-based
}

/** Result of generateNativeDslWithSourceMap. */
export interface DslWithSourceMap {
  code: string;
  sourceMap: Map<string, SourceMapEntry>;
}

/**
 * Recursively collect all nodes from a FlowIR, including nested nodes
 * inside scopes, ifs, foreachs, switches, and do-untils.
 */
function collectAllNodes(nodes: Node[]): Node[] {
  const result: Node[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.type === 'scope') {
      result.push(...collectAllNodes(node.actions || []));
    } else if (node.type === 'if') {
      result.push(...collectAllNodes(node.actions || []));
      if (node.elseActions) {
        result.push(...collectAllNodes(node.elseActions));
      }
    } else if (node.type === 'foreach') {
      result.push(...collectAllNodes(node.actions || []));
    } else if (node.type === 'switch') {
      for (const c of node.cases || []) {
        result.push(...collectAllNodes(c.actions || []));
      }
      if (node.defaultActions) {
        result.push(...collectAllNodes(node.defaultActions));
      }
    } else if (node.type === 'dountil') {
      result.push(...collectAllNodes(node.actions || []));
    }
  }
  return result;
}

/**
 * Find the start of a JSDoc block by walking backwards from a line index.
 * Returns the 0-based line index of the JSDoc opening `/**`.
 */
function findJSDocStart(lines: string[], lineIdx: number): number {
  for (let i = lineIdx; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('/**')) {
      return i;
    }
    // If we hit a line that isn't part of a JSDoc comment, stop
    if (!trimmed.startsWith('*') && !trimmed.startsWith('/**')) {
      return lineIdx;
    }
  }
  return lineIdx;
}

/**
 * Find the matching closing brace for a block starting from startLineIdx.
 * Counts braces and returns the line with the matching close.
 */
function findMatchingBrace(lines: string[], startLineIdx: number): number {
  let braceDepth = 0;
  let foundOpen = false;

  for (let i = startLineIdx; i < lines.length; i++) {
    const line = lines[i];
    // Skip string contents to avoid counting braces inside strings
    let inString = false;
    let stringChar = '';
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (inString) {
        if (ch === '\\') { j++; continue; }
        if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === '{') {
        braceDepth++;
        foundOpen = true;
      } else if (ch === '}') {
        braceDepth--;
        if (foundOpen && braceDepth === 0) {
          return i;
        }
      }
    }
  }
  return lines.length - 1;
}

/**
 * Find the end of a simple (non-control-flow) action statement.
 * Starts from the statement line (after any JSDoc) and walks forward
 * to the end of the statement.
 */
function findSimpleActionEnd(lines: string[], stmtLineIdx: number): number {
  let braceDepth = 0;
  let parenDepth = 0;

  for (let i = stmtLineIdx; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    for (const ch of lines[i]) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
      if (ch === '(') parenDepth++;
      if (ch === ')') parenDepth--;
    }

    // If we're at zero depth and line ends with semicolon, this is the end
    if (braceDepth <= 0 && parenDepth <= 0 && trimmed.endsWith(';')) {
      return i;
    }
  }

  return stmtLineIdx;
}

/**
 * Check if a line has a JSDoc comment immediately before it (on the previous line).
 * If so, return the start of the JSDoc. Otherwise return the line itself.
 */
function findPrecedingJSDoc(lines: string[], lineIdx: number): number {
  if (lineIdx <= 0) return lineIdx;

  // Check the line immediately before
  const prevTrimmed = lines[lineIdx - 1].trim();
  if (prevTrimmed.endsWith('*/')) {
    return findJSDocStart(lines, lineIdx - 1);
  }
  return lineIdx;
}

/** Check if a node type represents a control flow construct. */
function isControlFlowType(type: string): boolean {
  return type === 'scope' || type === 'if' || type === 'foreach' || type === 'switch' || type === 'dountil';
}

/**
 * Generate native DSL code from a FlowIR and produce a source map
 * that maps node names to their line ranges in the generated code.
 */
export function generateNativeDslWithSourceMap(
  ir: FlowIR,
  options: GeneratorOptions = {}
): DslWithSourceMap {
  const code = generateNativeDslFromIR(ir, options);
  const lines = code.split('\n');
  const sourceMap = new Map<string, SourceMapEntry>();

  // Collect all nodes from the IR
  const allNodes = collectAllNodes(ir.nodes);

  // Build lookup: node name -> node type
  const nodeInfo = new Map<string, string>();
  for (const node of allNodes) {
    nodeInfo.set(node.name, node.type);
  }

  // Build set of node names we still need to find
  const remainingNames = new Set<string>(nodeInfo.keys());

  // Pass 1: Find @action tags in JSDoc comments (control flow + variable actions)
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Check for @action tag in JSDoc comments
    const actionMatch = trimmed.match(/@action\s+(\S+)/);
    if (actionMatch) {
      const actionName = actionMatch[1].trim();

      // Skip case annotations (sub-parts of switch)
      if (trimmed.includes('@type case')) continue;
      // Skip 'default' (switch default case)
      if (actionName === 'default') continue;

      // Only map names that are in our IR
      if (!remainingNames.has(actionName)) continue;

      const startIdx = findJSDocStart(lines, i);
      const nodeType = nodeInfo.get(actionName)!;
      const isControl = isControlFlowType(nodeType);

      let endIdx: number;
      if (isControl) {
        // For control flow, find matching brace starting from the JSDoc
        endIdx = findMatchingBrace(lines, startIdx);
      } else {
        // For simple @action tags (variables etc), find end of the statement after the JSDoc
        // Find the first non-JSDoc line after the comment
        let stmtStart = i;
        for (let j = i; j < lines.length; j++) {
          const t = lines[j].trim();
          if (!t.startsWith('/**') && !t.startsWith('*') && !t.endsWith('*/') && t !== '') {
            stmtStart = j;
            break;
          }
        }
        endIdx = findSimpleActionEnd(lines, stmtStart);
      }

      sourceMap.set(actionName, {
        startLine: startIdx + 1,
        endLine: endIdx + 1,
      });
      remainingNames.delete(actionName);
    }
  }

  // Pass 2: Find ctx.method("NodeName", ...) calls for simple actions
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Match ctx.something("NodeName" patterns - the first string argument is the action name
    const ctxCallMatch = trimmed.match(/ctx\.\w+\(\s*"([^"]+)"/);
    if (ctxCallMatch) {
      const actionName = ctxCallMatch[1];
      if (!remainingNames.has(actionName)) continue;

      // The statement starts at this line, but may have a JSDoc comment before it
      const startIdx = findPrecedingJSDoc(lines, i);
      const endIdx = findSimpleActionEnd(lines, i);

      sourceMap.set(actionName, {
        startLine: startIdx + 1,
        endLine: endIdx + 1,
      });
      remainingNames.delete(actionName);
    }
  }

  // Pass 3: Find trigger decorators
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    const triggerMatch = trimmed.match(/^@(HttpTrigger|ManualTrigger|RecurrenceTrigger|ConnectorTrigger)\b/);
    if (triggerMatch) {
      // Find where this trigger decorator starts (possibly JSDoc above)
      const startIdx = findPrecedingJSDoc(lines, i);

      // Find the trigger method's closing brace
      const endIdx = findMatchingBrace(lines, i);

      // Find the trigger node name from the IR
      const triggerNode = allNodes.find(
        n => n.type === 'trigger' || n.type === 'recurrence'
      );
      if (triggerNode && remainingNames.has(triggerNode.name)) {
        sourceMap.set(triggerNode.name, {
          startLine: startIdx + 1,
          endLine: endIdx + 1,
        });
        remainingNames.delete(triggerNode.name);
      }
    }
  }

  return { code, sourceMap };
}
