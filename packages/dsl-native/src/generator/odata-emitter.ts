/**
 * Emit ctx.odata.* builder code from the shared OData AST.
 *
 * Generator direction of the OData grammar: parseODataFilterString (../odata/)
 * produces the AST, this module turns it into TypeScript DSL code. The caller
 * (odata-parser.ts) verifies the emission by feeding it through the actual
 * production transformer and comparing byte-for-byte with the source filter —
 * so this emitter may be optimistic; anything it cannot represent faithfully
 * throws ODataEmitBailout and the whole filter is preserved via ctx.odata.raw.
 */

import type { ODataFilter, ODataValue } from '../odata/ast.js';
import { parseStringValue } from './expression-parser.js';

/** Thrown when the AST contains a shape the ctx.odata builder API cannot express. */
export class ODataEmitBailout extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ODataEmitBailout';
  }
}

/**
 * Escape a string for use in a JavaScript double-quoted string literal.
 * Handles quotes, backslashes, and newlines/control characters.
 */
export function escapeForStringLiteral(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function fieldToCode(field: string): string {
  return `"${field.replace(/"/g, '\\"')}"`;
}

function valueToCode(v: ODataValue): string {
  switch (v.kind) {
    case 'string':
      // Historical emission formula for plain string values, unchanged.
      return `"${v.value.replace(/"/g, '\\"')}"`;
    case 'number':
      return v.raw;
    case 'bool':
      return String(v.value);
    case 'null':
      return 'null';
    case 'template':
      // Full expression parser handles @{...} → ctx.* code.
      return parseStringValue(v.raw).code;
    case 'verbatim': {
      // A quoted string containing @{...} templates (e.g. '@{variables('X')}.zip'):
      // strip the OData quotes and let the expression parser build a template
      // literal — the transformer re-quotes it on round-trip. (Historical
      // emission path; the caller's verifier guarantees byte-exactness.)
      if (v.text.length >= 2 && v.text.startsWith("'") && v.text.endsWith("'") && v.text.includes('@{')) {
        return parseStringValue(v.text.slice(1, -1)).code;
      }
      // Barewords have no faithful builder representation — preserve the
      // whole filter instead.
      throw new ODataEmitBailout(`unrepresentable value: ${v.text}`);
    }
  }
}

/**
 * A logical operand wrapped in explicit parens can be unwrapped when the
 * transformer will re-add those parens on round-trip (nested logical with a
 * different operator). Any other surviving group is unrepresentable.
 */
function unwrapLogicalOperand(operand: ODataFilter, parentOp: 'and' | 'or'): ODataFilter {
  if (operand.kind === 'group' && operand.inner.kind === 'logical' && operand.inner.op !== parentOp) {
    return operand.inner;
  }
  return operand;
}

export function emitODataFilter(node: ODataFilter, indent: string): string {
  switch (node.kind) {
    case 'compare':
      return `ctx.odata.${node.op}(${fieldToCode(node.field)}, ${valueToCode(node.value)})`;

    case 'func': {
      const method = { contains: 'contains', startswith: 'startsWith', endswith: 'endsWith' }[
        node.name
      ];
      return `ctx.odata.${method}(${fieldToCode(node.field)}, ${valueToCode(node.value)})`;
    }

    case 'logical': {
      const args = node.operands.map(o =>
        emitODataFilter(unwrapLogicalOperand(o, node.op), indent + '  ')
      );
      if (args.length === 1) return args[0];
      return `ctx.odata.${node.op}(\n${indent}  ${args.join(`,\n${indent}  `)}\n${indent})`;
    }

    case 'not':
      return `ctx.odata.not(${emitODataFilter(node.operand, indent)})`;

    case 'group':
      // A group that survives to emission carries parens the builder API
      // cannot reproduce (e.g. redundant parens around a comparison).
      throw new ODataEmitBailout('unrepresentable parentheses');

    case 'raw':
      return `ctx.odata.raw("${escapeForStringLiteral(node.text)}")`;
  }
}
