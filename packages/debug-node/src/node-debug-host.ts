/**
 * Node-side DebugHost, shared by the VS Code extension, the CLI, and the MCP
 * server: resolves child flows from .ff.ts files on disk and compiles them.
 * This is the only debug component allowed to touch fs/path — the session
 * core is host-agnostic. Connector construction lives in connectors.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { transformCode, buildSourceMapFromDsl } from '@flowforger/dsl-native';
import type { DebugFlowSource, DebugHost } from '@flowforger/debug-core';

export class NodeDebugHost implements DebugHost {
  constructor(private onOutput: (text: string, category: string) => void) {}

  normalizeKey(key: string): string {
    const resolved = path.resolve(key);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  displayName(key: string): string {
    return path.basename(key);
  }

  /**
   * Resolve a child flow's .ff.ts file given a workflow reference.
   * 1. ir.childFlows[ref].dslPath (relative to parent file)
   * 2. childFlows entry whose workflowId === ref
   * 3. Convention fallback: {ref}.ff.ts next to the parent
   * Then compile to IR + source map.
   */
  async resolveChildFlow(ref: string, parent: DebugFlowSource): Promise<DebugFlowSource | null> {
    const filePath = this.resolveChildFlowFile(ref, parent);
    if (!filePath) return null;
    return this.compileFile(filePath);
  }

  /** Compile a .ff.ts file into a DebugFlowSource (also used for breakpoint validation). */
  compileFile(filePath: string): DebugFlowSource | null {
    try {
      const dslCode = fs.readFileSync(filePath, 'utf-8');
      const ir = transformCode(dslCode);
      const sourceMap = buildSourceMapFromDsl(dslCode, ir);
      return { key: path.resolve(filePath), ir, sourceMap, dslCode };
    } catch (err: any) {
      this.onOutput(`Error compiling child flow '${filePath}': ${err.message}`, 'stderr');
      return null;
    }
  }

  private resolveChildFlowFile(ref: string, parent: DebugFlowSource): string | null {
    const parentDir = path.dirname(parent.key);

    if (parent.ir.childFlows) {
      const def = parent.ir.childFlows[ref];
      if (def?.dslPath) {
        const resolved = path.resolve(parentDir, def.dslPath);
        if (fs.existsSync(resolved)) return resolved;
        this.onOutput(`Warning: dslPath '${def.dslPath}' not found at ${resolved}`, 'console');
      }
      for (const [, childDef] of Object.entries(parent.ir.childFlows)) {
        if (childDef.workflowId === ref && childDef.dslPath) {
          const resolved = path.resolve(parentDir, childDef.dslPath);
          if (fs.existsSync(resolved)) return resolved;
        }
      }
    }

    const conventionPath = path.resolve(parentDir, `${ref}.ff.ts`);
    if (fs.existsSync(conventionPath)) return conventionPath;
    return null;
  }
}
