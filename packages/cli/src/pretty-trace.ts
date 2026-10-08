// ── Pretty trace rendering for `run` ─────────────────────────────────────────

type Paint = (s: string) => string;
type Palette = Record<'green' | 'red' | 'yellow' | 'cyan' | 'dim' | 'bold', Paint>;

function palette(color: boolean): Palette {
  const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    green: paint('32'),
    red: paint('31'),
    yellow: paint('33'),
    cyan: paint('36'),
    dim: paint('2'),
    bold: paint('1'),
  };
}

function summarizeValue(value: any, max = 100): string {
  if (value === undefined || value === null) return '';
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === '{}' || s === '[]') return '';
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

/** Fields that name a record, in the order connectors tend to use them. */
const LABEL_FIELDS = ['Title', 'title', 'DisplayName', 'displayName', 'Name', 'name', 'Subject', 'subject'];

/**
 * A loop item's label. A connector record (SharePoint item, Dataverse row, Graph object)
 * serializes starting with metadata like `{"Author":{"@odata.type":…`, so name it by its
 * title-like field instead; anything else falls back to its JSON.
 */
function iterationLabel(item: any): string {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const field = LABEL_FIELDS.find((f) => typeof item[f] === 'string' || typeof item[f] === 'number');
    if (field) return summarizeValue(item[field], 40);
  }
  return summarizeValue(item, 40);
}

/**
 * An action's output summary. A list operation's OData collection (`{ value: [...] }`,
 * possibly under `body`) prints as its item count rather than the first 100 characters of
 * the first record's metadata.
 */
function summarizeOutputs(outputs: any): string {
  const payload = outputs && typeof outputs === 'object' && 'body' in outputs ? outputs.body : outputs;
  if (payload && typeof payload === 'object' && Array.isArray(payload.value)) {
    const extra = Object.keys(payload).filter((k) => k !== 'value' && !k.startsWith('@odata.'));
    if (extra.length === 0) {
      const n = payload.value.length;
      return `${n} item${n === 1 ? '' : 's'}`;
    }
  }
  return summarizeValue(outputs);
}

function traceStatusIcon(status: string, clr: Palette): string {
  if (status === 'Succeeded') return clr.green('✓');
  if (status === 'Failed') return clr.red('✗');
  if (status === 'Skipped') return clr.dim('↷');
  if (status === 'Cancelled') return clr.yellow('⊘');
  return ' ';
}

function formatTraceEntry(entry: any, indent: number, clr: Palette, out: string[]): void {
  const pad = '  '.repeat(indent);
  const kind = typeof entry.nodeId === 'string' ? entry.nodeId.split('_')[0] : '';

  if (kind === 'trg') {
    out.push(`${pad}${clr.yellow('⚡')} ${clr.bold(entry.name)} ${clr.dim('(trigger)')}`);
    return;
  }

  if (kind === 'if' && entry.outputs && 'conditionResult' in entry.outputs) {
    const branch = entry.outputs.branchTaken === 'elseActions' ? 'else' : 'then';
    out.push(
      `${pad}${traceStatusIcon(entry.status, clr)} ${clr.bold(entry.name)} ${clr.dim(`condition → ${entry.outputs.conditionResult} (${branch} branch)`)}`
    );
  } else if (Array.isArray(entry.iterations)) {
    const n = entry.iterations.length;
    out.push(
      `${pad}${traceStatusIcon(entry.status, clr)} ${clr.bold(entry.name)} ${clr.dim(`— ${n} iteration${n === 1 ? '' : 's'}`)}`
    );
    for (const it of entry.iterations) {
      const label = it.item !== undefined ? iterationLabel(it.item) : `#${it.index}`;
      out.push(`${pad}  ${clr.cyan(`[${it.index + 1}/${n}]`)} ${clr.dim(label)}`);
      for (const a of it.actions ?? []) formatTraceEntry(a, indent + 2, clr, out);
    }
    return;
  } else {
    const summary = summarizeOutputs(entry.outputs);
    out.push(
      `${pad}${traceStatusIcon(entry.status, clr)} ${clr.bold(entry.name)}${summary ? ` ${clr.dim('→ ' + summary)}` : ''}`
    );
    if (entry.status === 'Failed' && entry.error) {
      const msg =
        entry.error instanceof Error
          ? entry.error.message
          : typeof entry.error === 'string'
            ? entry.error
            : summarizeValue(entry.error, 200);
      out.push(`${pad}  ${clr.red(msg)}`);
    }
  }

  // Scope/if/switch body, one level in under the block's own line.
  for (const child of entry.children ?? []) formatTraceEntry(child, indent + 1, clr, out);
}

/** Actions that ran (Skipped ones did not), at every depth. */
export function countTraceActions(entries: any[]): number {
  let n = 0;
  for (const e of entries ?? []) {
    if (typeof e.nodeId === 'string' && e.nodeId.startsWith('trg_')) continue;
    if (e.status !== 'Skipped') n++;
    n += countTraceActions(e.children);
    for (const it of e.iterations ?? []) n += countTraceActions(it.actions);
  }
  return n;
}

/** The human-readable `run` report, one string per line. */
export function formatPrettyRunResult(flowName: string, result: any, options: { color: boolean }): string[] {
  const clr = palette(options.color);
  const out: string[] = ['', clr.bold(`▶ ${flowName}`), ''];
  for (const entry of result.trace ?? []) formatTraceEntry(entry, 1, clr, out);
  out.push('');
  const n = countTraceActions(result.trace ?? []);
  if (result.status === 'Succeeded') {
    out.push(`${clr.green(clr.bold('✓ Flow succeeded'))} ${clr.dim(`— ${n} action${n === 1 ? '' : 's'} executed`)}`);
  } else if (result.status === 'Cancelled') {
    out.push(`${clr.yellow(clr.bold('⊘ Flow cancelled'))} ${clr.dim('— by a Terminate action')}`);
  } else {
    // A Terminate's runError is a plain { code, message } object.
    const err = result.error;
    const msg = err?.message ? String(err.message) : err ? String(err) : '';
    out.push(`${clr.red(clr.bold('✗ Flow failed'))}${msg ? ` ${clr.dim('— ' + msg)}` : ''}`);
  }
  out.push('');
  return out;
}

export function printPrettyRunResult(flowName: string, result: any): void {
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
  for (const line of formatPrettyRunResult(flowName, result, { color })) console.log(line);
}
