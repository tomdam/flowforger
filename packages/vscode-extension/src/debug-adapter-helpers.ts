/**
 * Pure decision helpers for the DAP adapter — deliberately free of any
 * `vscode` import so they can be unit-tested under plain node.
 */

import type { DslSourceMap } from '@flowforger/dsl-native';

/**
 * Restart mode: hot (Edit & Continue — recompile, replay, fast-forward back to
 * the paused position) only while a live session is suspended; otherwise a
 * clean start-over.
 */
export function chooseRestartMode(state: { hasRunner: boolean; paused: boolean }): 'hot' | 'clean' {
  return state.hasRunner && state.paused ? 'hot' : 'clean';
}

/**
 * Map an editor line to a node id: the exact line when it maps, else the
 * nearest mapped line BELOW it (the same forward-fall F9 uses for
 * breakpoints). Never falls backward — a line past the last statement has no
 * jump target.
 */
export function resolveNodeIdAtLine(sourceMap: DslSourceMap, line: number): string | null {
  const exact = sourceMap.lineToNodeId.get(line);
  if (exact) return exact;
  const next = [...sourceMap.breakpointableLines].filter((l) => l > line).sort((a, b) => a - b)[0];
  if (next === undefined) return null;
  return sourceMap.lineToNodeId.get(next) ?? null;
}

/** Whether the editor's text has diverged from what the running session compiled. */
export function isSourceDirty(current: string, compiled: string): boolean {
  return current !== compiled;
}
