/**
 * Collection / object functions.
 */

import { register, eager } from '../evaluator.js';

register('json', eager(([s]) => (typeof s === 'string' ? JSON.parse(s) : s)));

register('createArray', eager(vals => vals));

register('array', eager(([v]) => [v]));

register('first', eager(([v]) => {
  if (Array.isArray(v) && v.length > 0) return v[0];
  if (typeof v === 'string' && v.length > 0) return v[0];
  return undefined;
}));

register('last', eager(([v]) => {
  if (Array.isArray(v) && v.length > 0) return v[v.length - 1];
  if (typeof v === 'string' && v.length > 0) return v[v.length - 1];
  return undefined;
}));

register('skip', eager(([a, count]) => (Array.isArray(a) ? a.slice(Number(count)) : [])));
register('take', eager(([a, count]) => (Array.isArray(a) ? a.slice(0, Number(count)) : [])));

register('union', eager(([av, bv]) =>
  Array.isArray(av) && Array.isArray(bv) ? [...new Set([...av, ...bv])] : []));

register('intersection', eager(([av, bv]) =>
  Array.isArray(av) && Array.isArray(bv) ? av.filter(x => bv.includes(x)) : []));

register('range', eager(([start, count]) => {
  const st = Number(start);
  const ct = Number(count);
  return Array.from({ length: ct }, (_, i) => st + i);
}));

register('sort', eager(vals => {
  const arr = vals[0];
  if (!Array.isArray(arr)) return arr;
  if (vals.length >= 2) {
    const key = String(vals[1]);
    return [...arr].sort((a, b) => {
      const av = a?.[key], bv = b?.[key];
      if (av === bv) return 0;
      if (av === undefined || av === null) return -1;
      if (bv === undefined || bv === null) return 1;
      return av < bv ? -1 : 1;
    });
  }
  return [...arr].sort((a, b) => {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}));

register('reverse', eager(([v]) => {
  if (Array.isArray(v)) return [...v].reverse();
  if (typeof v === 'string') return v.split('').reverse().join('');
  return v;
}));

register('addProperty', eager(([o, nv, v]) => {
  const n = String(nv);
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    throw new Error(`addProperty: first argument must be an object`);
  }
  if (n in o) {
    throw new Error(`addProperty: property '${n}' already exists; use setProperty() to update`);
  }
  return { ...o, [n]: v };
}));

register('setProperty', eager(([o, nv, v]) => {
  const n = String(nv);
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    throw new Error(`setProperty: first argument must be an object`);
  }
  return { ...o, [n]: v };
}));

register('removeProperty', eager(([o, nv]) => {
  const n = String(nv);
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    throw new Error(`removeProperty: first argument must be an object`);
  }
  const result = { ...o } as Record<string, any>;
  delete result[n];
  return result;
}));
