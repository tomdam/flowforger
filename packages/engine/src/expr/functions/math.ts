/**
 * Numeric functions. All coerce args with Number() like the legacy chain.
 */

import { register, eager } from '../evaluator.js';

register('add', eager(([a, b]) => Number(a) + Number(b)));
register('sub', eager(([a, b]) => Number(a) - Number(b)));
register('mul', eager(([a, b]) => Number(a) * Number(b)));
register('div', eager(([a, b]) => Number(a) / Number(b)));
register('mod', eager(([a, b]) => Number(a) % Number(b)));
register('min', eager(([a, b]) => Math.min(Number(a), Number(b))));
register('max', eager(([a, b]) => Math.max(Number(a), Number(b))));

// Inclusive of max (legacy: floor(random * (max - min + 1)) + min)
register('rand', eager(([minV, maxV]) => {
  const lo = Number(minV);
  const hi = Number(maxV);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}));

register('int', eager(([v]) => Math.trunc(Number(v))));
register('float', eager(([v]) => parseFloat(String(v))));
register('abs', eager(([v]) => Math.abs(Number(v))));
register('ceil', eager(([v]) => Math.ceil(Number(v))));
register('floor', eager(([v]) => Math.floor(Number(v))));
register('round', eager(([v]) => Math.round(Number(v))));
register('decimal', eager(([v]) => Number(v)));
