/**
 * Comparison, logical, conditional, and type-predicate functions.
 *
 * if/and/or/coalesce are LAZY — they receive AST nodes and only evaluate
 * the args they need (matching legacy short-circuit semantics). and/or are
 * n-ary here; the legacy chain silently dropped args past the second.
 */

import { register, eager } from '../evaluator.js';

// Power Automate uses loose equality — equals(101, '101') is true.
// eslint-disable-next-line eqeqeq
register('equals', eager(([a, b]) => a == b));

register('greater', eager(([a, b]) => Number(a) > Number(b)));
register('less', eager(([a, b]) => Number(a) < Number(b)));
register(['greaterOrEquals', 'ge'], eager(([a, b]) => Number(a) >= Number(b)));
register(['lessOrEquals', 'le'], eager(([a, b]) => Number(a) <= Number(b)));

register('and', (args, { ev }) => args.every(a => Boolean(ev(a))));
register('or', (args, { ev }) => args.some(a => Boolean(ev(a))));
register('not', (args, { ev }) => !ev(args[0]));

register('if', (args, { ev }) => (ev(args[0]) ? ev(args[1]) : ev(args[2])));

register('coalesce', (args, { ev }) => {
  for (const a of args) {
    const v = ev(a);
    if (v !== null && v !== undefined) return v;
  }
  return undefined;
});

register('contains', eager(([c, v]) => {
  if (typeof c === 'string') return c.includes(String(v));
  if (Array.isArray(c)) return c.includes(v);
  return false;
}));

register('startsWith', eager(([s, p]) => String(s ?? '').startsWith(String(p ?? ''))));
register('endsWith', eager(([s, p]) => String(s ?? '').endsWith(String(p ?? ''))));

register('empty', eager(([v]) =>
  v === undefined || v === null ||
  (typeof v === 'string' && v.length === 0) ||
  (Array.isArray(v) && v.length === 0)));

register('bool', eager(([v]) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  if (typeof v === 'number') return v !== 0;
  return Boolean(v);
}));

register('isFloat', eager(([v]) => {
  const s = String(v ?? '').trim();
  return /^-?\d+\.\d+$/.test(s) && !isNaN(Number(s));
}));

register('isInt', eager(([v]) => {
  const s = String(v ?? '').trim();
  return /^-?\d+$/.test(s) && Number.isInteger(Number(s));
}));
