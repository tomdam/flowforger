/** Fields that name a record, in the order connectors tend to use them. */
const LABEL_FIELDS = ['Title', 'title', 'DisplayName', 'displayName', 'Name', 'name', 'Subject', 'subject'];

function summarizeValue(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = String(value);
  if (s === '{}' || s === '[]') return '';
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

/**
 * A loop item's label. A connector record (SharePoint item, Dataverse row, Graph object)
 * serializes starting with metadata like `{"Author":{"@odata.type":…`, so name it by its
 * title-like field instead; anything else falls back to its JSON, truncated to `max`.
 * Shared by the CLI's pretty trace and the web app's Pins pane / trace viewer.
 */
export function loopItemLabel(item: unknown, max = 40): string {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const rec = item as Record<string, unknown>;
    const field = LABEL_FIELDS.find((f) => typeof rec[f] === 'string' || typeof rec[f] === 'number');
    if (field) {
      // The field's text itself, not its JSON: a title reads better without quotes.
      const text = String(rec[field]);
      return text.length > max ? text.slice(0, max - 1) + '…' : text;
    }
  }
  return summarizeValue(item, max);
}
