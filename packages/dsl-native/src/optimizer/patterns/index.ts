/**
 * Optimizer Pattern Implementations
 *
 * Each pattern detects specific code patterns and either transforms them
 * or emits warnings about potential issues.
 */

export { optimizeSingleSetVariables } from './single-set-to-compose.js';
export { optimizeLoopVariables } from './loop-variable-to-compose.js';
export { optimizeAppendToSelect } from './append-to-select.js';
export { analyzeParallelismIssues } from './parallelism-analyzer.js';
export { detectHardcodedValues, applyHardcodedValueExtractions } from './hardcoded-to-envvar.js';
