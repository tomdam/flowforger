/**
 * Shared AST for OData $filter expressions.
 *
 * Used by both conversion directions:
 *  - generator: OData string → AST → ctx.odata.* builder code (odata-emitter.ts)
 *  - transformer: ctx.odata.* builder calls / tagged templates → AST → OData string
 *
 * The printer (printer.ts) is the single canonical serializer. It adds no
 * parentheses of its own — producers encode grouping explicitly via `group`
 * nodes, which lets producers with different parenthesization policies share
 * one printer byte-exactly.
 */

export type CompareOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le';

export type ODataValue =
  /** Quoted OData string literal; `value` is decoded (`''` → `'`). */
  | { kind: 'string'; value: string }
  /** Numeric literal; `raw` preserves the source numeral text (1.50 stays 1.50). */
  | { kind: 'number'; raw: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  /** Power Automate `@{...}` template, verbatim including the braces. */
  | { kind: 'template'; raw: string }
  /**
   * Printed as-is: unquoted barewords, placeholder substitutions from tagged
   * templates, and quoted strings containing embedded `@{...}` templates
   * (kept verbatim including their quotes).
   */
  | { kind: 'verbatim'; text: string };

export type ODataFilter =
  | { kind: 'compare'; field: string; op: CompareOp; value: ODataValue }
  | { kind: 'logical'; op: 'and' | 'or'; operands: ODataFilter[] }
  | { kind: 'not'; operand: ODataFilter }
  | {
      kind: 'func';
      name: 'contains' | 'startswith' | 'endswith';
      field: string;
      value: ODataValue;
    }
  /** Explicit parentheses from the source; printer emits `(...)`. */
  | { kind: 'group'; inner: ODataFilter }
  /** Verbatim passthrough (e.g. Microsoft.Dynamics.CRM.* calls, ctx.odata.raw). */
  | { kind: 'raw'; text: string };
