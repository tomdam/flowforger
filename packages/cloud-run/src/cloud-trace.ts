/**
 * Shape a cloud run (Flow API action records) like the engine's trace, so
 * `flowforger run-show` prints what `run --json` prints: `{ nodeId, name, status,
 * inputs?, outputs?, error?, children?, iterations? }` in definition order, a
 * block's body under `children`, a loop's under `iterations[].actions`.
 *
 * The Flow API lists a run's actions flat, each loop child with its last
 * repetition only; the flow's IR (parsed from the live clientdata) gives the
 * nesting, and a loop's iterations come from the children's repetitions, keyed
 * by the enclosing loops' item indexes. Values are the cloud's own (a connector
 * action's inputs are `{ host, parameters }`, a trigger's outputs `{ headers,
 * body }`); only the shape follows the local trace.
 */
import type { FlowIR, Node } from '@flowforger/ir';

/** One action of a run (or one repetition of it), with its inputs/outputs resolved. */
export interface CloudActionRecord {
  status: string;
  code?: string;
  error?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  repetitionCount?: number;
  startTime?: string;
  endTime?: string;
}

export interface CloudRepetition extends CloudActionRecord {
  /** The enclosing loops' item indexes, outermost first. */
  indexes: Array<{ scopeName: string; itemIndex: number }>;
}

export interface CloudRunSource {
  trigger?: { name?: string; status?: string; inputs?: unknown; outputs?: unknown; error?: unknown };
  actions: Record<string, CloudActionRecord>;
  /** The repetitions of an action inside a loop (called at most once per action name). */
  repetitions: (actionName: string) => Promise<CloudRepetition[]>;
}

export interface CloudTraceEntry {
  nodeId: string;
  name: string;
  status: string;
  /** The flow's trigger (always the first entry). */
  trigger?: true;
  code?: string;
  inputs?: unknown;
  outputs?: unknown;
  error?: unknown;
  children?: CloudTraceEntry[];
  iterations?: CloudTraceIteration[];
}

export interface CloudTraceIteration {
  index: number;
  status: string;
  actions: CloudTraceEntry[];
}

type Index = { scopeName: string; itemIndex: number };

const isLoop = (n: Node) => n.type === 'foreach' || n.type === 'dountil';
const isBlock = (n: Node) => n.type === 'scope' || n.type === 'if' || n.type === 'switch';

/** A block node's child lists in definition order: then/else, cases, then default. */
function childLists(node: any): Node[][] {
  const lists: Node[][] = [];
  if (Array.isArray(node.actions)) lists.push(node.actions);
  if (Array.isArray(node.elseActions)) lists.push(node.elseActions);
  for (const c of node.cases ?? []) if (Array.isArray(c.actions)) lists.push(c.actions);
  if (Array.isArray(node.defaultActions)) lists.push(node.defaultActions);
  return lists;
}

/** A repetition belongs to `prefix` when it carries exactly those loop indexes. */
function atPrefix(rep: CloudRepetition, prefix: Index[]): boolean {
  return rep.indexes.length === prefix.length &&
    prefix.every((p) => rep.indexes.some((i) => i.scopeName === p.scopeName && i.itemIndex === p.itemIndex));
}

export async function buildCloudTrace(ir: FlowIR, src: CloudRunSource): Promise<CloudTraceEntry[]> {
  const repsMemo = new Map<string, Promise<CloudRepetition[]>>();
  const reps = (name: string) => {
    let p = repsMemo.get(name);
    if (!p) {
      p = src.repetitions(name);
      repsMemo.set(name, p);
    }
    return p;
  };

  const record = async (node: Node, prefix: Index[]): Promise<CloudActionRecord | undefined> => {
    if (prefix.length === 0) return src.actions[node.name];
    return (await reps(node.name)).find((r) => atPrefix(r, prefix));
  };

  const entry = async (node: Node, prefix: Index[]): Promise<CloudTraceEntry> => {
    const rec = await record(node, prefix);
    const e: CloudTraceEntry = { nodeId: node.id, name: node.name, status: rec?.status ?? 'Skipped' };
    if (rec?.code !== undefined) e.code = rec.code;
    if (rec?.inputs !== undefined) e.inputs = rec.inputs;
    if (rec?.outputs !== undefined) e.outputs = rec.outputs;
    if (rec?.error !== undefined) e.error = rec.error;

    if (isBlock(node)) {
      e.children = [];
      for (const list of childLists(node)) for (const child of list) e.children.push(await entry(child, prefix));
    } else if (isLoop(node)) {
      const children: Node[] = (node as any).actions ?? [];
      const indexes = new Set<number>();
      for (const child of children) {
        for (const r of await reps(child.name)) {
          if (r.indexes.length !== prefix.length + 1) continue;
          if (!prefix.every((p) => r.indexes.some((i) => i.scopeName === p.scopeName && i.itemIndex === p.itemIndex))) continue;
          const own = r.indexes.find((i) => i.scopeName === node.name);
          if (own) indexes.add(own.itemIndex);
        }
      }
      e.iterations = [];
      for (const index of [...indexes].sort((a, b) => a - b)) {
        const inner = [...prefix, { scopeName: node.name, itemIndex: index }];
        const actions: CloudTraceEntry[] = [];
        for (const child of children) actions.push(await entry(child, inner));
        e.iterations.push({ index, status: actions.some((a) => a.status === 'Failed') ? 'Failed' : 'Succeeded', actions });
      }
    }
    return e;
  };

  const trace: CloudTraceEntry[] = [];
  for (const node of ir.nodes) {
    if (node.type === 'trigger' || node.type === 'recurrence') {
      const t = src.trigger;
      const e: CloudTraceEntry = { nodeId: node.id, name: t?.name ?? node.name, status: t?.status ?? 'Succeeded', trigger: true };
      if (t?.inputs !== undefined) e.inputs = t.inputs;
      if (t?.outputs !== undefined) e.outputs = t.outputs;
      if (t?.error !== undefined) e.error = t.error;
      trace.push(e);
      continue;
    }
    trace.push(await entry(node, []));
  }
  return trace;
}
