/**
 * Canonical serializer for the shared OData AST — the ONE place that decides
 * spacing, quoting, and function-call formatting for both conversion
 * directions.
 *
 * Deliberately adds no parentheses beyond `group` and `not (...)`: producers
 * encode their own grouping policy as explicit `group` nodes (the ts-morph
 * transformer wraps a nested logical only when its operator differs from the
 * parent's; the tagged-template builder wraps every nested logical, matching
 * their respective legacy byte behavior).
 */

import type { ODataFilter, ODataValue } from './ast.js';

export function printFilter(node: ODataFilter): string {
  switch (node.kind) {
    case 'raw':
      return node.text;
    case 'group':
      return `(${printFilter(node.inner)})`;
    case 'not':
      return `not (${printFilter(node.operand)})`;
    case 'logical':
      return node.operands.map(printFilter).join(` ${node.op} `);
    case 'compare':
      return `${node.field} ${node.op} ${printValue(node.value)}`;
    case 'func':
      return `${node.name}(${node.field}, ${printValue(node.value)})`;
  }
}

export function printValue(v: ODataValue): string {
  switch (v.kind) {
    case 'string':
      return `'${v.value.replace(/'/g, "''")}'`;
    case 'number':
      return v.raw;
    case 'bool':
      return v.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'template':
      return v.raw;
    case 'verbatim':
      return v.text;
  }
}
