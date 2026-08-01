/**
 * Find-all-references for DSL symbols.
 *
 * Actions, parameters and loops are referenced through *string literals*
 * (`ctx.body('FetchData')`, `ctx.parameters('siteUrl')`), which the TypeScript
 * language service has no symbol for — a plain "find references" therefore
 * returns nothing for them. Variables are the mixed case: `let counter = 0`
 * is a real TS identifier, but `ctx.variables('counter')` is not.
 *
 * This module resolves the symbol under the cursor and collects every place it
 * is declared or used, so editors can implement Peek/Find All References.
 */

import ts from 'typescript';
import {
  getNodeRange,
  type SourcePosition,
  type SourceRange,
} from '../analyzer/dsl-parser.js';
import { buildSymbolIndex, findLoop, type SymbolIndex } from '../analyzer/symbol-index.js';
import { findStringReferencesInLine, type StringReference } from './reference-detection.js';

/** What kind of occurrence a location represents. */
export type ReferenceKind =
  /** Where the symbol is declared (`let counter`, `ctx.http('Name', ...)`, ...) */
  | 'declaration'
  /** A DSL string reference (`ctx.variables('counter')`, `ctx.body('Name')`) */
  | 'stringReference'
  /** A plain TypeScript identifier usage (variables only) */
  | 'identifier';

/** One occurrence of the symbol. */
export interface ReferenceLocation {
  range: SourceRange;
  kind: ReferenceKind;
}

/** The symbol a find-references request resolved to. */
export interface ReferenceTarget {
  type: StringReference['type'];
  name: string;
}

export interface ReferenceResult {
  target: ReferenceTarget;
  /**
   * Whether the request started on a TypeScript identifier or on a DSL string
   * literal. Editors that also run the TypeScript language service should drop
   * everything but `stringReference` locations when this is `identifier`,
   * otherwise identifier hits are reported twice.
   */
  origin: 'identifier' | 'string';
  /** Every occurrence, ordered by position. */
  locations: ReferenceLocation[];
}

/**
 * Find all references to the DSL symbol at `position`.
 *
 * @param code - Full document text
 * @param position - 0-indexed line/character
 * @param index - Prebuilt symbol index (optional; built from `code` when omitted)
 * @returns The resolved symbol with all of its occurrences, or null when the
 *          position is not on a DSL symbol
 */
export function findReferences(
  code: string,
  position: SourcePosition,
  index?: SymbolIndex
): ReferenceResult | null {
  const symbolIndex = index ?? buildSymbolIndex(code);
  const lines = code.split(/\r?\n/);

  const resolved = resolveSymbolAtPosition(symbolIndex, lines, position);
  if (!resolved) return null;

  const { target, origin } = resolved;
  const locations: ReferenceLocation[] = [];

  // Declaration sites (and, for variables, every identifier usage).
  switch (target.type) {
    case 'variable': {
      const declaration = symbolIndex.variables.find(
        (v) => v.isInitialDeclaration && equalsName(v.name, target.name)
      );
      for (const range of findIdentifierRanges(symbolIndex.sourceFile, target.name)) {
        const isDeclaration =
          declaration !== undefined && rangesEqual(range, declaration.nameRange);
        locations.push({ range, kind: isDeclaration ? 'declaration' : 'identifier' });
      }
      break;
    }

    case 'action': {
      for (const action of symbolIndex.actions) {
        if (equalsName(action.name, target.name)) {
          locations.push({ range: action.nameRange, kind: 'declaration' });
        }
      }
      break;
    }

    case 'parameter': {
      for (const param of symbolIndex.parameters) {
        if (equalsName(param.name, target.name)) {
          locations.push({ range: param.range, kind: 'declaration' });
        }
      }
      break;
    }

    case 'loop': {
      const loop = findLoop(symbolIndex, target.name);
      if (loop) {
        locations.push({
          range: {
            start: loop.range.start,
            end: { line: loop.range.start.line, character: loop.range.start.character + 3 },
          },
          kind: 'declaration',
        });
      }
      break;
    }
  }

  // String references anywhere in the document.
  for (let line = 0; line < lines.length; line++) {
    for (const ref of findStringReferencesInLine(lines[line])) {
      if (ref.type !== target.type || !equalsName(ref.name, target.name)) continue;
      locations.push({
        range: {
          start: { line, character: ref.nameStart },
          end: { line, character: ref.nameEnd },
        },
        kind: 'stringReference',
      });
    }
  }

  return { target, origin, locations: dedupe(locations).sort(compareByPosition) };
}

/**
 * Work out which DSL symbol the cursor is on.
 *
 * Order matters: a string reference wins over the enclosing AST node, because
 * `'counter'` inside `ctx.variables('counter')` is a string literal that would
 * otherwise resolve to nothing.
 */
function resolveSymbolAtPosition(
  index: SymbolIndex,
  lines: string[],
  position: SourcePosition
): { target: ReferenceTarget; origin: 'identifier' | 'string' } | null {
  const lineText = lines[position.line];
  if (lineText === undefined) return null;

  // 1. A DSL string reference: ctx.variables('x'), ctx.body('x'), ...
  const stringRef = detectStringReferenceAt(lineText, position.character);
  if (stringRef) {
    return { target: { type: stringRef.type, name: stringRef.name }, origin: 'string' };
  }

  // 2. An action declaration: the name literal in ctx.http('Name', ...)
  const action = index.actions.find(
    (a) => rangeContains(a.nameRange, position) && isNameLiteralAt(lines, a.nameRange, a.name)
  );
  if (action) {
    return { target: { type: 'action', name: action.name }, origin: 'string' };
  }

  // 3. A parameter declaration: the key in ctx.flow.parameters
  const parameter = index.parameters.find((p) => rangeContains(p.range, position));
  if (parameter) {
    return { target: { type: 'parameter', name: parameter.name }, origin: 'string' };
  }

  // 4. A TypeScript identifier that names a flow variable (`let counter`,
  //    `counter = counter + 1`, ...)
  const identifier = findIdentifierAt(index.sourceFile, position);
  if (identifier && index.variables.some((v) => v.name === identifier)) {
    return { target: { type: 'variable', name: identifier }, origin: 'identifier' };
  }

  return null;
}

/**
 * Whether `range` actually spells out `name` as a quoted literal.
 *
 * Actions declared through JSDoc (`\@action Initialize_counter`) get a
 * *synthetic* nameRange anchored to the statement below the comment, so it
 * overlaps unrelated code — `let counter = 0` would otherwise resolve to the
 * action instead of the variable. Real declarations (`ctx.http('Name', ...)`)
 * point at the string literal itself.
 */
function isNameLiteralAt(lines: string[], range: SourceRange, name: string): boolean {
  if (range.start.line !== range.end.line) return false;
  const text = lines[range.start.line]?.slice(range.start.character, range.end.character);
  if (!text) return false;
  return text === `'${name}'` || text === `"${name}"` || text === `\`${name}\``;
}

/** Same as detectStringReference, but tolerant of a cursor sitting at the end of the name. */
function detectStringReferenceAt(lineText: string, character: number): StringReference | null {
  for (const ref of findStringReferencesInLine(lineText)) {
    if (character >= ref.nameStart && character <= ref.nameEnd) {
      return ref;
    }
  }
  return null;
}

/**
 * Collect the ranges of every identifier with the given name, skipping the
 * property side of `obj.counter` and object-literal keys like `{ counter: 1 }`
 * — those are unrelated to the flow variable.
 */
function findIdentifierRanges(sourceFile: ts.SourceFile, name: string): SourceRange[] {
  const ranges: SourceRange[] = [];

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === name && !isPropertyName(node)) {
      ranges.push(getNodeRange(sourceFile, node));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return ranges;
}

/** True when the identifier is a member/property name rather than a value reference. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  return false;
}

/** The identifier text at a position, if the position sits on one. */
function findIdentifierAt(sourceFile: ts.SourceFile, position: SourcePosition): string | null {
  let offset: number;
  try {
    offset = sourceFile.getPositionOfLineAndCharacter(position.line, position.character);
  } catch {
    return null;
  }

  let found: string | null = null;

  function visit(node: ts.Node): void {
    if (offset < node.getStart(sourceFile) || offset > node.getEnd()) return;
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      found = node.text;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/** Action, variable and parameter names are case-insensitive in Logic Apps. */
function equalsName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function rangeContains(range: SourceRange, position: SourcePosition): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) {
    return false;
  }
  if (position.line === range.end.line && position.character > range.end.character) {
    return false;
  }
  return true;
}

function rangesEqual(a: SourceRange, b: SourceRange): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

/**
 * Drop duplicate ranges. Overlapping detection patterns can report the same
 * span twice (e.g. an action name that is also matched by a @runAfter tag);
 * declarations win over plain occurrences.
 */
function dedupe(locations: ReferenceLocation[]): ReferenceLocation[] {
  const byRange = new Map<string, ReferenceLocation>();
  for (const location of locations) {
    const key = `${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
    const existing = byRange.get(key);
    if (!existing || (existing.kind !== 'declaration' && location.kind === 'declaration')) {
      byRange.set(key, location);
    }
  }
  return Array.from(byRange.values());
}

function compareByPosition(a: ReferenceLocation, b: ReferenceLocation): number {
  if (a.range.start.line !== b.range.start.line) {
    return a.range.start.line - b.range.start.line;
  }
  return a.range.start.character - b.range.start.character;
}
