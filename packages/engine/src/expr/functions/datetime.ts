/**
 * Date/time functions, with .NET DateTime semantics (see ../dotnet-date.ts): seven fraction
 * digits, the input's kind kept in the output (Z / no zone / +00:00), .NET format strings and
 * cultures, month arithmetic clamped to the month's end. Verified against the cloud
 * (conformance/flows/expressions.ff.ts).
 */

import { register, eager } from '../evaluator.js';
import { resolveTz, tzOffsetMs } from '../helpers.js';
import {
  formatNetDate,
  netTicks,
  requireDate,
  shiftNetDate,
  timeSpanText,
  totalTicks,
  type NetDate,
} from '../dotnet-date.js';
import { ExpressionError, typeName } from '../values.js';

const optional = (vals: any[], i: number): string | undefined =>
  vals.length > i && vals[i] !== null && vals[i] !== undefined ? String(vals[i]) : undefined;

function now(ctx: { now(): Date }): NetDate {
  return { ms: ctx.now().getTime(), sub: 0, kind: 'utc' };
}

register('utcNow', (args, { ctx, ev }) => formatNetDate(now(ctx), args.length ? String(ev(args[0])) : undefined));

register('formatDateTime', eager(vals => {
  const d = requireDate('formatDateTime', vals[0]);
  return formatNetDate(d, optional(vals, 1), optional(vals, 2));
}));

// parseDateTime(timestamp, locale?, format?)
register('parseDateTime', eager(vals => {
  const d = requireDate('parseDateTime', vals[0], optional(vals, 1), optional(vals, 2));
  return formatNetDate(d);
}));

function addUnit(fn: string, unit: string) {
  return eager((vals: any[]) => {
    const d = requireDate(fn, vals[0]);
    if (typeof vals[1] !== 'number') {
      throw new ExpressionError(
        `The template language function '${fn}' expects its second parameter to be an integer. The provided value is of type '${typeName(vals[1])}'. Please see https://aka.ms/logicexpressions#${fn.toLowerCase()} for usage details.`,
      );
    }
    return formatNetDate(shiftNetDate(d, vals[1], unit), optional(vals, 2));
  });
}

register('addDays', addUnit('addDays', 'Day'));
register('addHours', addUnit('addHours', 'Hour'));
register('addMinutes', addUnit('addMinutes', 'Minute'));
register('addSeconds', addUnit('addSeconds', 'Second'));

register('addToTime', eager(vals => {
  const d = requireDate('addToTime', vals[0]);
  return formatNetDate(shiftNetDate(d, Number(vals[1]), String(vals[2])), optional(vals, 3));
}));

register('subtractFromTime', eager(vals => {
  const d = requireDate('subtractFromTime', vals[0]);
  return formatNetDate(shiftNetDate(d, -Number(vals[1]), String(vals[2])), optional(vals, 3));
}));

register('getFutureTime', (args, { ctx, ev }) => {
  const vals = args.map(ev);
  return formatNetDate(shiftNetDate(now(ctx), Number(vals[0]), String(vals[1])), optional(vals, 2));
});

register('getPastTime', (args, { ctx, ev }) => {
  const vals = args.map(ev);
  return formatNetDate(shiftNetDate(now(ctx), -Number(vals[0]), String(vals[1])), optional(vals, 2));
});

register('ticks', eager(([v]) => netTicks(requireDate('ticks', v))));

const utcFields = (d: NetDate) => new Date(d.ms);

register('dayOfMonth', eager(([v]) => utcFields(requireDate('dayOfMonth', v)).getUTCDate()));
register('dayOfWeek', eager(([v]) => utcFields(requireDate('dayOfWeek', v)).getUTCDay()));
register('dayOfYear', eager(([v]) => {
  const t = utcFields(requireDate('dayOfYear', v));
  return Math.floor((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
}));

function startOf(fn: string, reset: (t: Date) => void) {
  return eager((vals: any[]) => {
    const d = requireDate(fn, vals[0]);
    const t = new Date(d.ms);
    reset(t);
    return formatNetDate({ ...d, ms: t.getTime(), sub: 0 }, optional(vals, 1));
  });
}

register('startOfDay', startOf('startOfDay', t => t.setUTCHours(0, 0, 0, 0)));
register('startOfHour', startOf('startOfHour', t => t.setUTCMinutes(0, 0, 0)));
register('startOfMonth', startOf('startOfMonth', t => { t.setUTCDate(1); t.setUTCHours(0, 0, 0, 0); }));

register('dateDifference', eager(([start, end]) =>
  timeSpanText(totalTicks(requireDate('dateDifference', end)) - totalTicks(requireDate('dateDifference', start)))));

// ---------------------------------------------------------------------------------------------
// Time zones. Windows ("W. Europe Standard Time") and IANA ("Europe/Berlin") ids are accepted.

function zone(fn: string, id: unknown): string {
  const tz = resolveTz(String(id ?? ''));
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ExpressionError(
      `In the template language function '${fn}', the value provided for the time zone id '${id}' was not valid.`,
    );
  }
  return tz;
}

const isUtcZone = (tz: string) => /^(utc|etc\/utc|etc\/gmt|gmt)$/i.test(tz);

/** A wall-clock moment in `tz` → epoch ms. */
function wallToUtc(wallMs: number, tz: string): number {
  let utc = wallMs - tzOffsetMs(new Date(wallMs), tz);
  utc = wallMs - tzOffsetMs(new Date(utc), tz); // second pass settles DST edges
  return utc;
}

/** An instant → the wall clock in `tz`, kind 'utc' when that zone is UTC. */
function inZone(utcMs: number, sub: number, tz: string): NetDate {
  if (isUtcZone(tz)) return { ms: utcMs, sub, kind: 'utc' };
  return { ms: utcMs + tzOffsetMs(new Date(utcMs), tz), sub, kind: 'unspecified' };
}

register('convertFromUtc', eager(vals => {
  const d = requireDate('convertFromUtc', vals[0]);
  const tz = zone('convertFromUtc', vals[1]);
  return formatNetDate(inZone(d.ms, d.sub, tz), optional(vals, 2));
}));

register('convertToUtc', eager(vals => {
  const d = requireDate('convertToUtc', vals[0]);
  const tz = zone('convertToUtc', vals[1]);
  if (d.kind === 'utc' && !isUtcZone(tz)) {
    throw new ExpressionError(
      `The template language function 'convertToUtc' expects its second parameter to be a time zone matching the time zone indicated by the timestamp. The provided value '${vals[1]}' does not match.`,
    );
  }
  const utc = d.kind === 'unspecified' ? wallToUtc(d.ms, tz) : d.ms;
  return formatNetDate({ ms: utc, sub: d.sub, kind: 'utc' }, optional(vals, 2));
}));

register('convertTimeZone', eager(vals => {
  const d = requireDate('convertTimeZone', vals[0]);
  const source = zone('convertTimeZone', vals[1]);
  const target = zone('convertTimeZone', vals[2]);
  const utc = d.kind === 'unspecified' ? wallToUtc(d.ms, source) : d.ms;
  return formatNetDate(inZone(utc, d.sub, target), optional(vals, 3));
}));
