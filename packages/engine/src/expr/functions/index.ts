/**
 * Side-effect registration of all expression function groups.
 * Import this module once before evaluating expressions.
 */

import './references.js';
import './logic.js';
import './strings.js';
import './collections.js';
import './math.js';
import './datetime.js';
import './encoding.js';

export { registry } from '../evaluator.js';
