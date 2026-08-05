/**
 * Date/time functions. All arithmetic is UTC-based, matching the legacy chain.
 *
 * Where legacy branches recursively invoked `@formatDateTime('<iso>', '<fmt>')`
 * for optional format args, these entries call formatDate() directly — same
 * token semantics, without re-entering the evaluator.
 */

import { register, eager } from '../evaluator.js';
import { shiftTime, resolveTz, tzOffsetMs, isoNoZone, parseAsUtc, TICKS_AT_EPOCH } from '../helpers.js';

// Basic .NET-style format token support (legacy formatDateTime body).
function formatDate(date: Date, format?: string): string {
  if (!format) return date.toISOString();
  let result = format;
  result = result.replace(/yyyy/g, String(date.getUTCFullYear()));
  result = result.replace(/yy/g, String(date.getUTCFullYear()).slice(-2));
  result = result.replace(/MM/g, String(date.getUTCMonth() + 1).padStart(2, '0'));
  result = result.replace(/M/g, String(date.getUTCMonth() + 1));
  result = result.replace(/dd/g, String(date.getUTCDate()).padStart(2, '0'));
  result = result.replace(/d/g, String(date.getUTCDate()));
  result = result.replace(/HH/g, String(date.getUTCHours()).padStart(2, '0'));
  result = result.replace(/H/g, String(date.getUTCHours()));
  result = result.replace(/mm/g, String(date.getUTCMinutes()).padStart(2, '0'));
  result = result.replace(/m/g, String(date.getUTCMinutes()));
  result = result.replace(/ss/g, String(date.getUTCSeconds()).padStart(2, '0'));
  result = result.replace(/s/g, String(date.getUTCSeconds()));
  return result;
}

register('utcNow', (args, { ctx, ev }) => {
  const now = ctx.now();
  // Legacy took no args; PA supports an optional format — honor it when given.
  if (args.length >= 1) return formatDate(now, String(ev(args[0])));
  return now.toISOString();
});

register('parseDateTime', eager(vals => {
  const timestamp = vals[0];
  const locale = vals.length >= 2 ? String(vals[1]) : undefined;

  if (timestamp === null || timestamp === undefined) return null;

  // For 'de-DE' locale, dates might be in DD.MM.YYYY format
  let dateStr = String(timestamp);
  if (locale === 'de-DE' && /^\d{1,2}\.\d{1,2}\.\d{4}/.test(dateStr)) {
    const parts = dateStr.split('.');
    if (parts.length >= 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const yearPart = parts[2].split(/\s/)[0]; // Handle "DD.MM.YYYY HH:mm" format
      const timePart = dateStr.includes(' ') ? dateStr.split(' ').slice(1).join(' ') : '';
      dateStr = `${yearPart}-${month}-${day}${timePart ? 'T' + timePart : ''}`;
    }
  }

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    try {
      const parsed = new Date(timestamp);
      if (!isNaN(parsed.getTime())) return parsed.toISOString();
    } catch {
      // Return null for invalid dates
    }
    return null;
  }
  return date.toISOString();
}));

register('formatDateTime', eager(vals => {
  const timestamp = vals[0];
  const format = vals.length >= 2 ? String(vals[1]) : undefined;
  if (timestamp === null || timestamp === undefined) return '';
  const date = new Date(String(timestamp));
  if (isNaN(date.getTime())) return '';
  return formatDate(date, format);
}));

function addUnit(setter: (d: Date, n: number) => void) {
  return eager((vals: any[]) => {
    const timestamp = vals[0];
    const n = Number(vals[1]);
    const format = vals.length >= 3 ? String(vals[2]) : undefined;
    if (timestamp === null || timestamp === undefined) return null;
    const date = new Date(String(timestamp));
    if (isNaN(date.getTime())) return null;
    setter(date, n);
    return format ? formatDate(date, format) : date.toISOString();
  });
}

register('addDays', addUnit((d, n) => d.setUTCDate(d.getUTCDate() + n)));
register('addHours', addUnit((d, n) => d.setUTCHours(d.getUTCHours() + n)));
register('addMinutes', addUnit((d, n) => d.setUTCMinutes(d.getUTCMinutes() + n)));
register('addSeconds', addUnit((d, n) => d.setUTCSeconds(d.getUTCSeconds() + n)));

register('addToTime', eager(vals => {
  const d = new Date(String(vals[0] ?? ''));
  if (isNaN(d.getTime())) return null;
  const result = shiftTime(d, Number(vals[1]), String(vals[2]));
  return vals.length >= 4 ? formatDate(result, String(vals[3])) : result.toISOString();
}));

register('subtractFromTime', eager(vals => {
  const d = new Date(String(vals[0] ?? ''));
  if (isNaN(d.getTime())) return null;
  const result = shiftTime(d, -Number(vals[1]), String(vals[2]));
  return vals.length >= 4 ? formatDate(result, String(vals[3])) : result.toISOString();
}));

register('getFutureTime', (args, { ctx, ev }) => {
  const vals = args.map(ev);
  const result = shiftTime(ctx.now(), Number(vals[0]), String(vals[1]));
  return vals.length >= 3 ? formatDate(result, String(vals[2])) : result.toISOString();
});

register('getPastTime', (args, { ctx, ev }) => {
  const vals = args.map(ev);
  const result = shiftTime(ctx.now(), -Number(vals[0]), String(vals[1]));
  return vals.length >= 3 ? formatDate(result, String(vals[2])) : result.toISOString();
});

register('ticks', eager(([v]) => {
  const d = new Date(String(v ?? ''));
  if (isNaN(d.getTime())) return 0;
  return TICKS_AT_EPOCH + d.getTime() * 10000;
}));

register('dayOfMonth', eager(([v]) => {
  const d = new Date(String(v ?? ''));
  return isNaN(d.getTime()) ? null : d.getUTCDate();
}));

register('dayOfWeek', eager(([v]) => {
  const d = new Date(String(v ?? ''));
  return isNaN(d.getTime()) ? null : d.getUTCDay();
}));

register('dayOfYear', eager(([v]) => {
  const d = new Date(String(v ?? ''));
  if (isNaN(d.getTime())) return null;
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86_400_000) + 1;
}));

function startOf(reset: (d: Date) => void) {
  return eager((vals: any[]) => {
    const d = new Date(String(vals[0] ?? ''));
    if (isNaN(d.getTime())) return null;
    reset(d);
    return vals.length >= 2 ? formatDate(d, String(vals[1])) : d.toISOString();
  });
}

register('startOfDay', startOf(d => d.setUTCHours(0, 0, 0, 0)));
register('startOfHour', startOf(d => d.setUTCMinutes(0, 0, 0)));
register('startOfMonth', startOf(d => { d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); }));

register('dateDifference', eager(([sv, ev2]) => {
  const start = new Date(String(sv ?? ''));
  const end = new Date(String(ev2 ?? ''));
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return '00:00:00';
  let diff = end.getTime() - start.getTime();
  const sign = diff < 0 ? '-' : '';
  diff = Math.abs(diff);
  const days = Math.floor(diff / 86_400_000); diff %= 86_400_000;
  const hours = Math.floor(diff / 3_600_000); diff %= 3_600_000;
  const minutes = Math.floor(diff / 60_000); diff %= 60_000;
  const seconds = Math.floor(diff / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${sign}${days > 0 ? days + '.' : ''}${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}));

// Timezone conversion. Accepts both Windows ("Pacific Standard Time") and
// IANA ("America/Los_Angeles") zone names.
register('convertFromUtc', eager(vals => {
  const utc = new Date(String(vals[0] ?? ''));
  if (isNaN(utc.getTime())) return null;
  const tz = resolveTz(String(vals[1] ?? ''));
  const local = new Date(utc.getTime() + tzOffsetMs(utc, tz));
  if (vals.length >= 3) return formatDate(local, String(vals[2]));
  return isoNoZone(local);
}));

register('convertToUtc', eager(vals => {
  const local = parseAsUtc(String(vals[0] ?? ''));
  if (isNaN(local.getTime())) return null;
  const tz = resolveTz(String(vals[1] ?? ''));
  const utc = new Date(local.getTime() - tzOffsetMs(local, tz));
  if (vals.length >= 3) return formatDate(utc, String(vals[2]));
  return utc.toISOString();
}));

register('convertTimeZone', eager(vals => {
  const local = parseAsUtc(String(vals[0] ?? ''));
  if (isNaN(local.getTime())) return null;
  const srcTz = resolveTz(String(vals[1] ?? ''));
  const destTz = resolveTz(String(vals[2] ?? ''));
  const utc = new Date(local.getTime() - tzOffsetMs(local, srcTz));
  const dest = new Date(utc.getTime() + tzOffsetMs(utc, destTz));
  if (vals.length >= 4) return formatDate(dest, String(vals[3]));
  return isoNoZone(dest);
}));
