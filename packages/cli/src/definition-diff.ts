/**
 * Structural diff of two Logic Apps definitions, reported per action.
 *
 * Both sides go through `normalizeDefinition` first (the tolerance `parity`
 * uses: operationMetadataId and the config's `parser.skipMetadataFields`
 * dropped, default `$authentication`/`$connections` and empty runAfter
 * ignored, expression whitespace and function case normalized, `item/field`
 * keys unflattened, key order irrelevant). Nested actions (scope, if/else,
 * foreach, until, switch cases) are flattened by name, so an action is
 * compared with its namesake wherever it sits, and a move is reported as such.
 *
 * `connectionReferences` are compared by key only: `push` sends whatever the
 * local compile produced, but the values the cloud holds (logical names,
 * connection ids) are what keep a deployed flow's connections attached, so a
 * value difference is listed for information and never counts as a change.
 */
import type { FlowForgerConfig } from '@flowforger/ir';
import { DEFAULT_CONFIG } from '@flowforger/ir';
import { normalizeDefinition, findSemanticDiffs, type SemanticDiff } from './parity.js';

/** One differing property; an absent side is `undefined`. */
export interface PropertyChange {
  path: string;
  live?: unknown;
  local?: unknown;
}

export type ChangeKind = 'type' | 'inputs' | 'expression' | 'runAfter' | 'moved' | 'other';
export type EntryStatus = 'only-local' | 'only-live' | 'changed';

/** The diff of one action, trigger or parameter. */
export interface EntryDiff {
  name: string;
  status: EntryStatus;
  /** Where the action sits: '' at the root, else e.g. `Try/Condition (else)`. */
  container?: { live?: string; local?: string };
  type?: { live?: string; local?: string };
  kinds: ChangeKind[];
  changes: PropertyChange[];
}

export interface ConnectionReferenceDiff {
  onlyLive: string[];
  onlyLocal: string[];
  /** Keys present on both sides with different values — informational only. */
  valueDifferences: string[];
}

export interface FlowDiffReport {
  identical: boolean;
  summary: { onlyLocal: number; onlyLive: number; changed: number; compared: number };
  actions: EntryDiff[];
  triggers: EntryDiff[];
  parameters: EntryDiff[];
  /** Definition-level fields other than actions/triggers/parameters (description, ...). */
  flow: PropertyChange[];
  connectionReferences: ConnectionReferenceDiff;
}

export interface DiffOptions {
  config?: FlowForgerConfig;
}

interface FlatEntry {
  name: string;
  container: string;
  def: any;
}

const KIND_ORDER: ChangeKind[] = ['type', 'inputs', 'expression', 'runAfter', 'moved', 'other'];

/** The definition inside a clientdata envelope, a standalone wrapper, or bare. */
export function extractDefinition(json: any): any {
  return json?.properties?.definition ?? json?.definition ?? json ?? {};
}

function extractConnectionReferences(json: any): Record<string, unknown> {
  const refs = json?.properties?.connectionReferences ?? json?.connectionReferences;
  return refs && typeof refs === 'object' ? refs : {};
}

function isObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function withoutActions(block: any): any {
  if (!isObject(block)) return block;
  const copy = { ...block };
  delete copy.actions;
  return copy;
}

/**
 * Walk a definition's action tree and index every action by name with the
 * container it sits in. The indexed definition keeps a container's own
 * properties (expression, foreach, runAfter, the case values, ...) but not
 * its children, which are entries of their own.
 */
function flattenActions(actions: unknown, container: string, out: Map<string, FlatEntry>): void {
  if (!isObject(actions)) return;
  for (const [name, action] of Object.entries(actions)) {
    if (!isObject(action)) continue;
    const own = withoutActions(action);
    if ('else' in own) {
      const rest = withoutActions(own.else);
      if (isObject(rest) && Object.keys(rest).length === 0) delete own.else;
      else own.else = rest;
    }
    if ('default' in own) {
      const rest = withoutActions(own.default);
      if (isObject(rest) && Object.keys(rest).length === 0) delete own.default;
      else own.default = rest;
    }
    if (isObject(own.cases)) {
      const cases: Record<string, any> = {};
      for (const [caseName, c] of Object.entries(own.cases)) cases[caseName] = withoutActions(c);
      own.cases = cases;
    }
    out.set(name, { name, container, def: own });

    const here = container ? `${container}/${name}` : name;
    flattenActions(action.actions, here, out);
    if (isObject(action.else)) flattenActions(action.else.actions, `${here} (else)`, out);
    if (isObject(action.cases)) {
      for (const [caseName, c] of Object.entries(action.cases)) {
        if (isObject(c)) flattenActions(c.actions, `${here} (case ${caseName})`, out);
      }
    }
    if (isObject(action.default)) flattenActions(action.default.actions, `${here} (default)`, out);
  }
}

function flattenMap(entries: unknown, out: Map<string, FlatEntry>): void {
  if (!isObject(entries)) return;
  for (const [name, def] of Object.entries(entries)) out.set(name, { name, container: '', def });
}

function kindOf(path: string): ChangeKind {
  const head = path.split(/[.[]/, 1)[0];
  switch (head) {
    case 'type': return 'type';
    case 'inputs': return 'inputs';
    case 'expression':
    case 'foreach': return 'expression';
    case 'runAfter': return 'runAfter';
    default: return 'other';
  }
}

function toChange(d: SemanticDiff): PropertyChange {
  const change: PropertyChange = { path: d.path };
  if (d.type !== 'extra_in_output') change.live = d.originalValue;
  if (d.type !== 'missing_in_output') change.local = d.outputValue;
  return change;
}

function sortKinds(kinds: Iterable<ChangeKind>): ChangeKind[] {
  const set = new Set(kinds);
  return KIND_ORDER.filter((k) => set.has(k));
}

/** Compare two name-indexed maps (live vs local) entry by entry. */
function diffEntries(live: Map<string, FlatEntry>, local: Map<string, FlatEntry>, withContainer: boolean): EntryDiff[] {
  const out: EntryDiff[] = [];
  const names = [...live.keys(), ...[...local.keys()].filter((n) => !live.has(n))];
  for (const name of names) {
    const l = live.get(name);
    const r = local.get(name);
    if (l && !r) {
      out.push(entry(name, 'only-live', l, undefined, withContainer, [], []));
      continue;
    }
    if (r && !l) {
      out.push(entry(name, 'only-local', undefined, r, withContainer, [], []));
      continue;
    }
    if (!l || !r) continue;
    const changes = findSemanticDiffs(l.def, r.def).map(toChange);
    const kinds = new Set<ChangeKind>(changes.map((c) => kindOf(c.path)));
    if (withContainer && l.container !== r.container) {
      kinds.add('moved');
      changes.push({ path: 'container', live: l.container, local: r.container });
    }
    if (changes.length === 0) continue;
    out.push(entry(name, 'changed', l, r, withContainer, sortKinds(kinds), changes));
  }
  return out;
}

function entry(
  name: string,
  status: EntryStatus,
  live: FlatEntry | undefined,
  local: FlatEntry | undefined,
  withContainer: boolean,
  kinds: ChangeKind[],
  changes: PropertyChange[],
): EntryDiff {
  const e: EntryDiff = { name, status, kinds, changes };
  if (withContainer) {
    e.container = {};
    if (live) e.container.live = live.container;
    if (local) e.container.local = local.container;
    const liveType = live?.def?.type;
    const localType = local?.def?.type;
    if (typeof liveType === 'string' || typeof localType === 'string') {
      e.type = {};
      if (typeof liveType === 'string') e.type.live = liveType;
      if (typeof localType === 'string') e.type.local = localType;
    }
  }
  return e;
}

/**
 * Diff two flows (clientdata envelopes, standalone `{ definition }` wrappers
 * or bare definitions). `live` is the deployed flow, `local` what a push would
 * send; changes read live → local.
 */
export function diffDefinitions(live: any, local: any, opts: DiffOptions = {}): FlowDiffReport {
  const config = opts.config ?? DEFAULT_CONFIG;
  const liveDef = normalizeDefinition(extractDefinition(live), config) ?? {};
  const localDef = normalizeDefinition(extractDefinition(local), config) ?? {};

  const liveActions = new Map<string, FlatEntry>();
  const localActions = new Map<string, FlatEntry>();
  flattenActions(liveDef.actions, '', liveActions);
  flattenActions(localDef.actions, '', localActions);
  const actions = diffEntries(liveActions, localActions, true);

  const liveTriggers = new Map<string, FlatEntry>();
  const localTriggers = new Map<string, FlatEntry>();
  flattenMap(liveDef.triggers, liveTriggers);
  flattenMap(localDef.triggers, localTriggers);
  const triggers = diffEntries(liveTriggers, localTriggers, true);

  const liveParams = new Map<string, FlatEntry>();
  const localParams = new Map<string, FlatEntry>();
  flattenMap(liveDef.parameters, liveParams);
  flattenMap(localDef.parameters, localParams);
  const parameters = diffEntries(liveParams, localParams, false);

  const rest = (def: any) => {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(def ?? {})) {
      if (k === 'actions' || k === 'triggers' || k === 'parameters') continue;
      r[k] = v;
    }
    return r;
  };
  const flow = findSemanticDiffs(rest(liveDef), rest(localDef)).map(toChange);

  const liveRefs = extractConnectionReferences(live);
  const localRefs = extractConnectionReferences(local);
  const connectionReferences: ConnectionReferenceDiff = { onlyLive: [], onlyLocal: [], valueDifferences: [] };
  for (const key of Object.keys(liveRefs)) {
    if (!(key in localRefs)) connectionReferences.onlyLive.push(key);
    else if (findSemanticDiffs(liveRefs[key], localRefs[key]).length > 0) connectionReferences.valueDifferences.push(key);
  }
  for (const key of Object.keys(localRefs)) {
    if (!(key in liveRefs)) connectionReferences.onlyLocal.push(key);
  }

  const all = [...actions, ...triggers, ...parameters];
  const summary = {
    onlyLocal: all.filter((e) => e.status === 'only-local').length,
    onlyLive: all.filter((e) => e.status === 'only-live').length,
    changed: all.filter((e) => e.status === 'changed').length,
    compared: new Set([...liveActions.keys(), ...localActions.keys()]).size,
  };
  const identical =
    all.length === 0 &&
    flow.length === 0 &&
    connectionReferences.onlyLive.length === 0 &&
    connectionReferences.onlyLocal.length === 0;

  return { identical, summary, actions, triggers, parameters, flow, connectionReferences };
}

/** Names of everything the live flow has that the local file lacks. */
export function liveOnlyNames(report: FlowDiffReport): string[] {
  const names: string[] = [];
  for (const e of report.actions) if (e.status === 'only-live') names.push(`action '${e.name}'`);
  for (const e of report.triggers) if (e.status === 'only-live') names.push(`trigger '${e.name}'`);
  for (const e of report.parameters) if (e.status === 'only-live') names.push(`parameter '${e.name}'`);
  return names;
}

function formatValue(v: unknown): string {
  if (v === undefined) return '(absent)';
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function formatEntry(e: EntryDiff, lines: string[], showContainer: boolean): void {
  const mark = e.status === 'only-local' ? '+' : e.status === 'only-live' ? '-' : '~';
  let head = `  ${mark} ${e.name.padEnd(30)} `;
  if (e.status === 'changed') {
    head += `changed (${e.kinds.join(', ')})`;
  } else {
    head += e.status === 'only-local' ? 'only local' : 'only live';
    if (showContainer) {
      const where = e.status === 'only-local' ? e.container?.local : e.container?.live;
      const type = e.status === 'only-local' ? e.type?.local : e.type?.live;
      const bits = [type, where ? `in ${where}` : 'at root'].filter(Boolean);
      if (bits.length) head += `  [${bits.join(', ')}]`;
    }
  }
  lines.push(head.trimEnd());
  for (const c of e.changes) {
    lines.push(`      ${c.path}: ${formatValue(c.live)} → ${formatValue(c.local)}`);
  }
}

/** The human-readable report `flowforger diff` prints on a terminal. */
export function formatDiffReport(
  report: FlowDiffReport,
  ctx: { flowName: string; workflowId: string; file: string },
): string[] {
  const title = `Flow '${ctx.flowName}' (${ctx.workflowId}) vs local ${ctx.file}`;
  const lines: string[] = [];
  const { onlyLocal, onlyLive, changed, compared } = report.summary;
  const total = onlyLocal + onlyLive + changed + report.flow.length +
    report.connectionReferences.onlyLive.length + report.connectionReferences.onlyLocal.length;
  if (report.identical) {
    lines.push(`${title}: identical (${compared} action${compared === 1 ? '' : 's'} compared)`);
  } else {
    lines.push(`${title}: ${total} difference${total === 1 ? '' : 's'} (live → local)`);
  }
  if (report.actions.length) {
    lines.push('Actions:');
    for (const e of report.actions) formatEntry(e, lines, true);
  }
  if (report.triggers.length) {
    lines.push('Trigger:');
    for (const e of report.triggers) formatEntry(e, lines, true);
  }
  if (report.parameters.length) {
    lines.push('Parameters:');
    for (const e of report.parameters) formatEntry(e, lines, false);
  }
  if (report.flow.length) {
    lines.push('Flow:');
    for (const c of report.flow) lines.push(`  ${c.path}: ${formatValue(c.live)} → ${formatValue(c.local)}`);
  }
  const refs = report.connectionReferences;
  if (refs.onlyLive.length || refs.onlyLocal.length || refs.valueDifferences.length) {
    const bits: string[] = [];
    if (refs.onlyLive.length) bits.push(`only live: ${refs.onlyLive.join(', ')}`);
    if (refs.onlyLocal.length) bits.push(`only local: ${refs.onlyLocal.join(', ')}`);
    if (refs.valueDifferences.length) {
      bits.push(`values differ (not counted; the cloud's values keep the connections attached): ${refs.valueDifferences.join(', ')}`);
    }
    lines.push(`Connection references: ${bits.join('; ')}`);
  }
  return lines;
}
