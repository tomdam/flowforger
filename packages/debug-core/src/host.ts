import type { FlowIR } from '@flowforger/ir';
import type { DslSourceMap } from '@flowforger/dsl-native';

/**
 * One debuggable flow source: the root flow or a resolved child flow.
 * `key` is the host's identity for the source — an absolute file path in the
 * VS Code extension, a flow name in the web app. `sourceMap`/`dslCode` are
 * null when no DSL source is available (e.g. IR-only child flows in the web);
 * the session then debugs the flow without line mapping or DSL-syntax
 * expression scope, which degrades gracefully.
 */
export interface DebugFlowSource {
  key: string;
  ir: FlowIR;
  sourceMap: DslSourceMap | null;
  dslCode: string | null;
}

/**
 * Host-environment services the debug session cannot provide itself.
 * Implemented with fs/path in the extension and with in-memory flow
 * registries in the web app. Must be side-effect free apart from I/O.
 */
export interface DebugHost {
  /**
   * Resolve a child flow reference (workflow name or workflowId) relative to
   * a parent source. Return null when the child cannot be found — the session
   * then falls back to the engine's own child handling (mock/loadChildFlow).
   */
  resolveChildFlow(ref: string, parent: DebugFlowSource): Promise<DebugFlowSource | null>;
  /** Normalize a key for identity comparison (case-insensitive paths on Windows hosts). */
  normalizeKey(key: string): string;
  /** Short human-readable label for a key (path basename, or the flow name itself). */
  displayName(key: string): string;
}
