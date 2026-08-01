import { Project, SyntaxKind, ScriptTarget, NewLineKind } from 'ts-morph';

// NOTE: this module must stay free of `node:fs`. It is reachable from the
// package entry point, which the web app bundles for the browser — Vite maps
// `node:fs` to an empty shim and the build fails on the missing export. The
// filesystem wrapper around this lives in the CLI (`src/workflow-id-writeback.ts`).

const BOM = '﻿';

/** Dominant line ending in `source`: CRLF if it has more `\r\n` than bare `\n`. */
function detectNewLineKind(source: string): NewLineKind {
  const crlfCount = (source.match(/\r\n/g) || []).length;
  const lfCount = (source.match(/(?<!\r)\n/g) || []).length;
  return crlfCount >= lfCount ? NewLineKind.CarriageReturnLineFeed : NewLineKind.LineFeed;
}

/**
 * Stamp a workflowId into the `@Flow` decorator of a DSL source string.
 *
 * Accepts the same two shapes `extractFlowWorkflowId` reads
 * (`transformer/index.ts`):
 *   @Flow("Name")            -> @Flow({ name: "Name", workflowId: "<guid>" })
 *   @Flow({ name: "Name" })  -> gains a workflowId property
 *
 * This is a targeted AST edit rather than a regeneration, so comments and
 * hand-written code are preserved.
 *
 * Returns the rewritten source, or null when there is no editable @Flow
 * decorator (no decorator, no arguments, or a non-literal argument). Callers
 * treat null as "tell the user the GUID" — never as a failure.
 */
export function setFlowWorkflowIdInSource(source: string, workflowId: string): string | null {
  const hasBom = source.startsWith(BOM);
  const bareSource = hasBom ? source.slice(BOM.length) : source;
  const newLineKind = detectNewLineKind(bareSource);

  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.ES2022, experimentalDecorators: true },
    manipulationSettings: { newLineKind },
  });
  const sourceFile = project.createSourceFile('flow.ff.ts', bareSource);

  const finish = (): string => {
    const text = sourceFile.getFullText();
    return hasBom ? BOM + text : text;
  };

  for (const cls of sourceFile.getClasses()) {
    const decorator = cls.getDecorator('Flow');
    if (!decorator) continue;

    const args = decorator.getArguments();
    if (args.length === 0) return null;
    const first = args[0];

    // @Flow("Name") — widen to the object form
    if (first.getKind() === SyntaxKind.StringLiteral) {
      const name = first.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      first.replaceWithText(
        `{ name: ${JSON.stringify(name)}, workflowId: ${JSON.stringify(workflowId)} }`
      );
      return finish();
    }

    // @Flow({ ... }) — set or add the property
    if (first.getKind() === SyntaxKind.ObjectLiteralExpression) {
      const obj = first.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
      const existing = obj.getProperty('workflowId');
      if (existing) {
        if (existing.getKind() !== SyntaxKind.PropertyAssignment) return null;
        existing
          .asKindOrThrow(SyntaxKind.PropertyAssignment)
          .setInitializer(JSON.stringify(workflowId));
      } else {
        obj.addPropertyAssignment({
          name: 'workflowId',
          initializer: JSON.stringify(workflowId),
        });
      }
      return finish();
    }

    // Anything else (identifier, call, template) is not safely editable
    return null;
  }

  return null;
}
