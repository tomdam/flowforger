/**
 * DSL Parser using TypeScript Compiler API.
 * Parses DSL code and extracts structured information for language features.
 */

import ts from 'typescript';

/**
 * Parse TypeScript/DSL source code into an AST.
 */
export function parseSource(code: string, fileName = 'flow.ff.ts'): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.ES2020,
    true, // setParentNodes - important for traversal
    ts.ScriptKind.TS
  );
}

/**
 * Position in source code (0-indexed).
 */
export interface SourcePosition {
  line: number;
  character: number;
}

/**
 * Range in source code.
 */
export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

/**
 * Convert a TypeScript position to line/character.
 */
export function getPositionFromOffset(
  sourceFile: ts.SourceFile,
  offset: number
): SourcePosition {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return { line, character };
}

/**
 * Convert a TypeScript node to a source range.
 */
export function getNodeRange(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  return {
    start: getPositionFromOffset(sourceFile, node.getStart(sourceFile)),
    end: getPositionFromOffset(sourceFile, node.getEnd()),
  };
}

/**
 * Find the node at a specific position.
 */
export function findNodeAtPosition(
  sourceFile: ts.SourceFile,
  position: SourcePosition
): ts.Node | undefined {
  const offset = sourceFile.getPositionOfLineAndCharacter(position.line, position.character);

  function find(node: ts.Node): ts.Node | undefined {
    if (offset >= node.getStart(sourceFile) && offset < node.getEnd()) {
      // Check children for a more specific match
      let result: ts.Node | undefined;
      ts.forEachChild(node, (child) => {
        const found = find(child);
        if (found) {
          result = found;
        }
      });
      return result || node;
    }
    return undefined;
  }

  return find(sourceFile);
}

/**
 * Check if a node is inside a specific call expression argument.
 */
export function isInsideCallArgument(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  callName: string,
  argumentIndex: number
): boolean {
  let current: ts.Node | undefined = node;

  while (current) {
    if (ts.isCallExpression(current)) {
      // Check if this is the call we're looking for
      const callText = current.expression.getText(sourceFile);
      if (callText.endsWith(callName) || callText === callName) {
        // Check if we're in the correct argument
        const args = current.arguments;
        if (args.length > argumentIndex) {
          const arg = args[argumentIndex];
          if (node.getStart(sourceFile) >= arg.getStart(sourceFile) &&
              node.getEnd() <= arg.getEnd()) {
            return true;
          }
        }
      }
    }
    current = current.parent;
  }

  return false;
}

/**
 * Check if a position is inside a string literal that is the first argument of a call.
 */
export function isInsideFirstStringArgument(
  sourceFile: ts.SourceFile,
  position: SourcePosition,
  callPatterns: RegExp[]
): { isInside: boolean; callName?: string } {
  const node = findNodeAtPosition(sourceFile, position);
  if (!node) return { isInside: false };

  // Walk up to find if we're in a string literal
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      // Check if parent is a call expression argument
      const parent = current.parent;
      if (ts.isCallExpression(parent)) {
        const argIndex = parent.arguments.indexOf(current as ts.Expression);
        if (argIndex === 0) {
          const callText = parent.expression.getText(sourceFile);
          for (const pattern of callPatterns) {
            if (pattern.test(callText)) {
              return { isInside: true, callName: callText };
            }
          }
        }
      }
    }
    current = current.parent;
  }

  return { isInside: false };
}

/**
 * Find the enclosing function/method for a position.
 */
export function findEnclosingFunction(
  sourceFile: ts.SourceFile,
  position: SourcePosition
): ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | undefined {
  const node = findNodeAtPosition(sourceFile, position);
  if (!node) return undefined;

  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isArrowFunction(current)) {
      return current;
    }
    current = current.parent;
  }

  return undefined;
}

/**
 * Find all for...of loops that contain the given position.
 */
export function findEnclosingForOfLoops(
  sourceFile: ts.SourceFile,
  position: SourcePosition
): ts.ForOfStatement[] {
  const node = findNodeAtPosition(sourceFile, position);
  if (!node) return [];

  const loops: ts.ForOfStatement[] = [];
  let current: ts.Node | undefined = node;

  while (current) {
    if (ts.isForOfStatement(current)) {
      loops.push(current);
    }
    current = current.parent;
  }

  return loops;
}

/**
 * Extract the variable name from a for...of loop initializer.
 */
export function getForOfLoopVariable(loop: ts.ForOfStatement): string | undefined {
  const init = loop.initializer;

  if (ts.isVariableDeclarationList(init)) {
    const decl = init.declarations[0];
    if (decl && ts.isIdentifier(decl.name)) {
      return decl.name.text;
    }
  }

  return undefined;
}

/**
 * Check if a node has a specific decorator.
 */
export function hasDecorator(node: ts.Node, decoratorName: string): boolean {
  const modifiers = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (!modifiers) return false;

  return modifiers.some((decorator) => {
    if (ts.isCallExpression(decorator.expression)) {
      const expr = decorator.expression.expression;
      return ts.isIdentifier(expr) && expr.text === decoratorName;
    }
    if (ts.isIdentifier(decorator.expression)) {
      return decorator.expression.text === decoratorName;
    }
    return false;
  });
}

/**
 * Get the decorator argument (first argument) if present.
 */
export function getDecoratorArgument(
  node: ts.Node,
  decoratorName: string
): ts.Expression | undefined {
  const modifiers = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (!modifiers) return undefined;

  for (const decorator of modifiers) {
    if (ts.isCallExpression(decorator.expression)) {
      const expr = decorator.expression.expression;
      if (ts.isIdentifier(expr) && expr.text === decoratorName) {
        return decorator.expression.arguments[0];
      }
    }
  }

  return undefined;
}

/**
 * Find the @Flow class in the source file.
 */
export function findFlowClass(sourceFile: ts.SourceFile): ts.ClassDeclaration | undefined {
  let flowClass: ts.ClassDeclaration | undefined;

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isClassDeclaration(node) && hasDecorator(node, 'Flow')) {
      flowClass = node;
    }
  });

  return flowClass;
}

/**
 * Find the @Action method in a class.
 */
export function findActionMethod(
  classDecl: ts.ClassDeclaration
): ts.MethodDeclaration | undefined {
  for (const member of classDecl.members) {
    if (ts.isMethodDeclaration(member) && hasDecorator(member, 'Action')) {
      return member;
    }
  }
  return undefined;
}

/**
 * Find trigger methods in a class.
 */
export function findTriggerMethod(
  classDecl: ts.ClassDeclaration
): ts.MethodDeclaration | undefined {
  const triggerDecorators = [
    'HttpTrigger',
    'ManualTrigger',
    'RecurrenceTrigger',
    'ConnectorTrigger',
  ];

  for (const member of classDecl.members) {
    if (ts.isMethodDeclaration(member)) {
      for (const decorator of triggerDecorators) {
        if (hasDecorator(member, decorator)) {
          return member;
        }
      }
    }
  }
  return undefined;
}
