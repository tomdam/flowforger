/**
 * Fast-forward controller for edit-and-continue.
 *
 * After an "apply changes & continue", the new DebugSession runs in continue
 * mode with this controller wired into DebugSessionOptions. It pauses the
 * session before the previous paused node's Nth execution (iteration-aware),
 * or at the node boundary right after a replay divergence — whichever comes
 * first. While `active`, the host suppresses user breakpoints; on arrival the
 * controller deactivates and breakpoints rearm.
 */

import type { Node } from '@flowforger/ir';

export interface FastForwardTarget {
  /** Name of the node the old session was paused before. */
  nodeName: string;
  /**
   * Completed executions of that node in the old run at pause time.
   * Pause-before semantics: the new run pauses before execution number
   * hitCount + 1, i.e. when countOf(nodeName) === hitCount.
   */
  hitCount: number;
}

export interface FastForwardDeps {
  /** Completed executions of a node (by name) in the NEW run's root frame. */
  countOf: (nodeName: string) => number;
  /** Whether the session is currently executing the root flow (call stack empty). */
  isRootFrame: () => boolean;
  /** Fired once when the controller deactivates by reaching a stop point. */
  onArrived?: (reason: 'target' | 'divergence') => void;
}

export class FastForwardController {
  active = true;
  private divergencePending = false;

  constructor(
    private target: FastForwardTarget | null,
    private deps: FastForwardDeps,
  ) {}

  /** Signal a replay cache miss (wire to ReplayEvents.onDivergence). */
  noteDivergence(): void {
    if (this.active) this.divergencePending = true;
  }

  /** Wire to DebugSessionOptions.shouldPauseBefore. */
  shouldPauseBefore(node: Node): boolean {
    if (!this.active) return false;
    if (this.divergencePending) {
      this.arrive('divergence');
      return true;
    }
    if (
      this.target &&
      this.deps.isRootFrame() &&
      node.name === this.target.nodeName &&
      this.deps.countOf(node.name) === this.target.hitCount
    ) {
      this.arrive('target');
      return true;
    }
    return false;
  }

  private arrive(reason: 'target' | 'divergence'): void {
    this.active = false;
    this.deps.onArrived?.(reason);
  }
}
