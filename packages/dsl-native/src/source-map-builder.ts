/**
 * DSL Source Map Builder
 *
 * Builds a bidirectional source map from user-written DSL code and compiled IR.
 * Maps DSL line numbers to IR node IDs and vice versa, enabling:
 * - Breakpoint setting by clicking DSL editor gutter
 * - Current execution line highlighting during debug
 */

import type { FlowIR, Node } from '@flowforger/ir';
import type { SourceMapEntry } from './generator-sourcemap.js';

/** Bidirectional source map between DSL lines and IR node IDs. */
export interface DslSourceMap {
  /** Map from 1-based DSL line number to IR node ID (for gutter clicks). */
  lineToNodeId: Map<number, string>;
  /** Map from IR node ID to DSL line range, 1-based inclusive (for execution highlighting). */
  nodeIdToLines: Map<string, SourceMapEntry>;
  /** Set of line numbers that are "breakpointable" (first line of each mapped node). */
  breakpointableLines: Set<number>;
}

// ---------------------------------------------------------------------------
// Utility functions (duplicated from generator-sourcemap.ts to avoid coupling)
// ---------------------------------------------------------------------------

/** Recursively collect all nodes from IR, including nested control flow. */
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

/** Walk backwards from lineIdx to find the opening of a JSDoc block. */
function findJSDocStart(lines: string[], lineIdx: number): number {
  for (let i = lineIdx; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('/**')) {
      return i;
    }
    if (!trimmed.startsWith('*') && !trimmed.startsWith('/**')) {
      return lineIdx;
    }
  }
  return lineIdx;
}

/** Find the matching closing brace starting from startLineIdx. */
function findMatchingBrace(lines: string[], startLineIdx: number): number {
  let braceDepth = 0;
  let foundOpen = false;

  for (let i = startLineIdx; i < lines.length; i++) {
    const line = lines[i];
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

/** Find the end of a simple (non-control-flow) action statement. */
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

    if (braceDepth <= 0 && parenDepth <= 0 && trimmed.endsWith(';')) {
      return i;
    }
  }

  return stmtLineIdx;
}

/** Check if the line before lineIdx ends a JSDoc; if so, return JSDoc start. */
function findPrecedingJSDoc(lines: string[], lineIdx: number): number {
  if (lineIdx <= 0) return lineIdx;

  const prevTrimmed = lines[lineIdx - 1].trim();
  if (prevTrimmed.endsWith('*/')) {
    return findJSDocStart(lines, lineIdx - 1);
  }
  return lineIdx;
}

/** Whether a node type is a control-flow construct. */
function isControlFlowType(type: string): boolean {
  return type === 'scope' || type === 'if' || type === 'foreach' || type === 'switch' || type === 'dountil';
}

/** Sanitize a variable name using the same rules as the DSL transformer. */
function sanitizeVarName(name: string): string {
  return name.replace(/[^\p{L}\p{N}_$]/gu, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').replace(/^[0-9]/, '_$&') || '_var';
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a bidirectional source map from user-written DSL code and compiled IR.
 *
 * Uses the same 3-pass pattern-matching algorithm as generateNativeDslWithSourceMap
 * (JSDoc @action tags, ctx.method() calls, trigger decorators) plus a 4th pass
 * for variable declarations/assignments that don't use those patterns.
 */
export function buildSourceMapFromDsl(dslCode: string, ir: FlowIR): DslSourceMap {
  const lines = dslCode.split('\n');

  // Collect all IR nodes and build lookups
  const allNodes = collectAllNodes(ir.nodes);
  const nodeInfo = new Map<string, string>(); // name -> type
  const nameToId = new Map<string, string>(); // name -> id
  for (const node of allNodes) {
    nodeInfo.set(node.name, node.type);
    nameToId.set(node.name, node.id);
  }

  // Source map: nodeName -> line range
  const nameToLines = new Map<string, SourceMapEntry>();
  const remainingNames = new Set<string>(nodeInfo.keys());

  // Pass 1: @action tags in JSDoc comments
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    const actionMatch = trimmed.match(/@action\s+(\S+)/);
    if (actionMatch) {
      const actionName = actionMatch[1].trim();

      if (trimmed.includes('@type case')) continue;
      if (actionName === 'default') continue;
      if (!remainingNames.has(actionName)) continue;

      const startIdx = findJSDocStart(lines, i);
      const nodeType = nodeInfo.get(actionName)!;
      const isControl = isControlFlowType(nodeType);

      let endIdx: number;
      if (isControl) {
        endIdx = findMatchingBrace(lines, startIdx);
      } else {
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

      nameToLines.set(actionName, {
        startLine: startIdx + 1,
        endLine: endIdx + 1,
      });
      remainingNames.delete(actionName);
    }
  }

  // Pass 2: ctx.method("NodeName", ...) and connector calls like ctx.connectors.x.Op('Name', ...)
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Match ctx.method('Name' or .method('Name' patterns (covers connector chains too)
    const ctxCallMatch = trimmed.match(/\.(\w+)\s*\(\s*['"]([^'"]+)['"]/);
    if (ctxCallMatch) {
      const methodName = ctxCallMatch[1];
      // Skip reference methods that read other actions' outputs (not action-creating)
      if (['body', 'outputs', 'triggerBody', 'triggerOutputs', 'trigger', 'actions', 'eval', 'parameters', 'workflow'].includes(methodName)) continue;
      const actionName = ctxCallMatch[2];
      if (!remainingNames.has(actionName)) continue;

      const startIdx = findPrecedingJSDoc(lines, i);
      const endIdx = findSimpleActionEnd(lines, i);

      nameToLines.set(actionName, {
        startLine: startIdx + 1,
        endLine: endIdx + 1,
      });
      remainingNames.delete(actionName);
    }
  }

  // Pass 3: Trigger decorators
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    const triggerMatch = trimmed.match(/^@(HttpTrigger|ManualTrigger|RecurrenceTrigger|ConnectorTrigger)\b/);
    if (triggerMatch) {
      const startIdx = findPrecedingJSDoc(lines, i);
      const endIdx = findMatchingBrace(lines, i);

      const triggerNode = allNodes.find(
        n => n.type === 'trigger' || n.type === 'recurrence'
      );
      if (triggerNode && remainingNames.has(triggerNode.name)) {
        nameToLines.set(triggerNode.name, {
          startLine: startIdx + 1,
          endLine: endIdx + 1,
        });
        remainingNames.delete(triggerNode.name);
      }
    }
  }

  // Pass 4: Variable patterns (declarations, assignments, array push)
  if (remainingNames.size > 0) {
    // Build variable node lookup: sanitized var name -> node[]
    const variableKinds = ['initializevariable', 'setvariable', 'incrementvariable', 'decrementvariable', 'appendtoarrayvariable', 'appendtostringvariable'];
    const varNodes = allNodes.filter(
      (n): n is Node & { type: 'action'; kind: string; inputs: any } =>
        n.type === 'action' && 'kind' in n && variableKinds.includes((n as any).kind) && remainingNames.has(n.name)
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Pattern 4a: let varName: type = ... (initializevariable)
      let nameMatch = line.match(/^\s*let\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*:/u);
      if (nameMatch) {
        const sanitized = nameMatch[1];
        const node = varNodes.find(
          n => (n as any).kind === 'initializevariable' &&
            sanitizeVarName((n as any).inputs?.variableName || (n as any).inputs?.name || '') === sanitized &&
            remainingNames.has(n.name)
        );
        if (node) {
          const startIdx = findPrecedingJSDoc(lines, i);
          const endIdx = findSimpleActionEnd(lines, i);
          nameToLines.set(node.name, { startLine: startIdx + 1, endLine: endIdx + 1 });
          remainingNames.delete(node.name);
          continue;
        }
      }

      // Pattern 4b: varName.push(...) (appendtoarrayvariable)
      nameMatch = line.match(/^\s*([\p{L}_$][\p{L}\p{N}_$]*)\.push\(/u);
      if (nameMatch) {
        const sanitized = nameMatch[1];
        const node = varNodes.find(
          n => (n as any).kind === 'appendtoarrayvariable' &&
            sanitizeVarName((n as any).inputs?.name || '') === sanitized &&
            remainingNames.has(n.name)
        );
        if (node) {
          const startIdx = findPrecedingJSDoc(lines, i);
          const endIdx = findSimpleActionEnd(lines, i);
          nameToLines.set(node.name, { startLine: startIdx + 1, endLine: endIdx + 1 });
          remainingNames.delete(node.name);
          continue;
        }
      }

      // Pattern 4c: varName = ... (setvariable, incrementvariable, etc.)
      // Exclude let/const/var declarations (already handled in 4a)
      if (line.match(/^\s*(let|const|var)\s/)) continue;
      nameMatch = line.match(/^\s*([\p{L}_$][\p{L}\p{N}_$]*)\s*[+\-*/]?=\s/u);
      if (nameMatch) {
        const sanitized = nameMatch[1];
        const node = varNodes.find(
          n => sanitizeVarName((n as any).inputs?.name || (n as any).inputs?.variableName || '') === sanitized &&
            remainingNames.has(n.name)
        );
        if (node) {
          const startIdx = findPrecedingJSDoc(lines, i);
          const endIdx = findSimpleActionEnd(lines, i);
          nameToLines.set(node.name, { startLine: startIdx + 1, endLine: endIdx + 1 });
          remainingNames.delete(node.name);
        }
      }
    }
  }

  // Build nodeId-based maps from the name-based source map
  const nodeIdToLines = new Map<string, SourceMapEntry>();
  const breakpointableLines = new Set<number>();

  for (const [nodeName, entry] of nameToLines) {
    const nodeId = nameToId.get(nodeName);
    if (nodeId) {
      nodeIdToLines.set(nodeId, entry);
      breakpointableLines.add(entry.startLine);
    }
  }

  // Build lineToNodeId: for each line, which node does it belong to?
  // For overlapping ranges (nested nodes), smallest range wins.
  const lineToNodeId = new Map<number, string>();

  // Sort entries by range size descending so smaller (more specific) ranges overwrite larger ones
  const sortedEntries = [...nodeIdToLines.entries()].sort(
    (a, b) => (b[1].endLine - b[1].startLine) - (a[1].endLine - a[1].startLine)
  );

  for (const [nodeId, entry] of sortedEntries) {
    for (let line = entry.startLine; line <= entry.endLine; line++) {
      lineToNodeId.set(line, nodeId);
    }
  }

  return { lineToNodeId, nodeIdToLines, breakpointableLines };
}
