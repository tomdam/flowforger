/**
 * String functions.
 */

import { register, eager } from '../evaluator.js';
import { formatNumberValue } from '../helpers.js';

register('concat', eager(vals => vals.map(v => String(v ?? '')).join('')));

register('substring', eager(vals => {
  const s = String(vals[0] ?? '');
  const st = Number(vals[1]);
  const l = vals.length >= 3 ? Number(vals[2]) : undefined;
  return l !== undefined ? s.substring(st, st + l) : s.substring(st);
}));

register('replace', eager(([str, old, newVal]) => {
  const s = String(str ?? '');
  const o = String(old);
  const n = String(newVal);
  const escaped = o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return s.replace(new RegExp(escaped, 'g'), n);
}));

register('toLower', eager(([v]) => String(v ?? '').toLowerCase()));
register('toUpper', eager(([v]) => String(v ?? '').toUpperCase()));
register('trim', eager(([v]) => String(v ?? '').trim()));

register('split', eager(([str, delim]) => String(str ?? '').split(String(delim))));

register('join', eager(([arr, delim]) => {
  const d = String(delim ?? ',');
  return Array.isArray(arr) ? arr.join(d) : '';
}));

register('indexOf', eager(([str, search]) => String(str ?? '').indexOf(String(search))));
register('lastIndexOf', eager(([str, search]) => String(str ?? '').lastIndexOf(String(search))));

register('nthIndexOf', eager(([tv, sv, nv]) => {
  const t = String(tv ?? '');
  const s = String(sv ?? '');
  const n = Number(nv);
  if (n < 1 || s === '') return -1;
  let idx = -1, count = 0, pos = 0;
  while (count < n) {
    idx = t.indexOf(s, pos);
    if (idx === -1) return -1;
    count++;
    pos = idx + 1;
  }
  return idx;
}));

register('guid', () => crypto.randomUUID());

register('string', eager(([v]) => (typeof v === 'string' ? v : JSON.stringify(v))));

register('length', eager(([v]) =>
  Array.isArray(v) || typeof v === 'string' ? (v as any).length : 0));

register('slice', eager(vals => {
  const v = vals[0];
  const start = Number(vals[1]);
  const end = vals.length >= 3 ? Number(vals[2]) : undefined;
  if (typeof v === 'string') return v.slice(start, end);
  if (Array.isArray(v)) return v.slice(start, end);
  return v;
}));

register('chunk', eager(([arr, sizeV]) => {
  const size = Number(sizeV);
  if (!Array.isArray(arr) || size <= 0) return [];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}));

register('formatNumber', eager(vals => {
  const value = Number(vals[0]);
  const format = vals.length >= 2 ? String(vals[1]) : 'G';
  const locale = vals.length >= 3 ? String(vals[2]) : 'en-US';
  return formatNumberValue(value, format, locale);
}));
