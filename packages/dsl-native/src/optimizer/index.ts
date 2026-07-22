/**
 * @flowforger/dsl-native - DSL Optimizer
 *
 * Optimizes Power Automate DSL for better performance by applying best practices:
 * - Convert single-set variables to compose actions (~2x faster)
 * - Convert loop variables to compose actions (enables parallelism)
 * - Convert append-to-array patterns to select actions (enables parallelism)
 * - Warn about variable usage that disables parallelism
 */

import type { FlowIR, FlowForgerConfig } from '@flowforger/ir';
import { DEFAULT_CONFIG } from '@flowforger/ir';
import { transformCode } from '../transformer/index.js';
import { generateNativeDslFromIR } from '../generator.js';
import { resetIdCounter } from '../utils/id-generator.js';
import {
  OptimizationReport,
  createEmptyReport,
} from './report.js';
import { optimizeSingleSetVariables } from './patterns/single-set-to-compose.js';
import { optimizeLoopVariables } from './patterns/loop-variable-to-compose.js';
import { optimizeAppendToSelect } from './patterns/append-to-select.js';
import { analyzeParallelismIssues } from './patterns/parallelism-analyzer.js';
import { detectHardcodedValues, applyHardcodedValueExtractions } from './patterns/hardcoded-to-envvar.js';
import { detectDirectConnections, applyConnectionRefConversions } from './patterns/connection-to-connref.js';

// Re-export report types
export * from './report.js';

// Re-export hardcoded value extraction utilities
export { applyHardcodedValueExtractions } from './patterns/hardcoded-to-envvar.js';

// Re-export connection reference conversion utilities
export { applyConnectionRefConversions } from './patterns/connection-to-connref.js';

/**
 * Options for DSL optimization.
 */
export interface OptimizeOptions {
  /** Enable/disable specific optimizations (all enabled by default) */
  optimizations?: {
    /** Convert variables that are only initialized (never mutated) to compose */
    singleSetVariableToCompose?: boolean;
    /** Convert variables declared inside loops to compose */
    loopVariableToCompose?: boolean;
    /** Convert append-to-array-in-loop patterns to select */
    appendToSelect?: boolean;
  };
  /** Include parallelism warnings in report (default: true) */
  includeParallelismWarnings?: boolean;
  /** FlowForger config for generator */
  config?: FlowForgerConfig;
  /** Action names to exclude from optimization (they will be left unchanged) */
  excludeActions?: string[];
}

/**
 * Result of DSL optimization.
 */
export interface OptimizeResult {
  /** The optimized DSL code */
  code: string;
  /** Detailed report of changes and warnings */
  report: OptimizationReport;
  /** The optimized IR (intermediate representation) */
  ir: FlowIR;
  /** The original IR before optimization (deep clone) */
  originalIr: FlowIR;
}

/**
 * Default optimization options.
 */
const DEFAULT_OPTIMIZE_OPTIONS: Required<OptimizeOptions> = {
  optimizations: {
    singleSetVariableToCompose: true,
    loopVariableToCompose: true,
    appendToSelect: true,
  },
  includeParallelismWarnings: true,
  config: DEFAULT_CONFIG,
  excludeActions: [],
};

/**
 * Optimizes DSL code by applying performance best practices.
 *
 * The optimization pipeline:
 * 1. Parse DSL to IR
 * 2. Analyze and transform IR
 * 3. Regenerate DSL from optimized IR
 *
 * @param dslCode - TypeScript DSL source code
 * @param options - Optimization options
 * @returns Optimized code, report, and IR
 *
 * @example
 * ```typescript
 * const result = await optimizeDsl(sourceCode);
 * console.log(result.report.summary);
 * fs.writeFileSync('optimized.ff.ts', result.code);
 * ```
 */
export async function optimizeDsl(
  dslCode: string,
  options?: OptimizeOptions
): Promise<OptimizeResult> {
  const opts = mergeOptions(options);

  // Reset ID counter for consistent transformation
  resetIdCounter();

  // Step 1: Parse DSL to IR
  const ir = transformCode(dslCode, 'input.ff.ts', opts.config);

  // Save original IR before optimization
  const originalIr = JSON.parse(JSON.stringify(ir)) as FlowIR;

  // Step 2: Optimize IR
  const { ir: optimizedIR, report } = optimizeIR(ir, opts);

  // Step 3: Generate optimized DSL
  resetIdCounter();
  const code = generateNativeDslFromIR(optimizedIR, { config: opts.config });

  return {
    code,
    report,
    ir: optimizedIR,
    originalIr,
  };
}

/**
 * Optimizes a FlowIR directly (for programmatic use).
 *
 * @param ir - The FlowIR to optimize
 * @param options - Optimization options
 * @returns Optimized IR and detailed report
 */
export function optimizeIR(
  ir: FlowIR,
  options?: OptimizeOptions
): { ir: FlowIR; report: OptimizationReport } {
  const opts = mergeOptions(options);
  const report = createEmptyReport(ir.name);
  const excludeSet = opts.excludeActions.length > 0 ? new Set(opts.excludeActions) : undefined;

  // Deep clone the IR to avoid mutating the original
  let optimizedIR = JSON.parse(JSON.stringify(ir)) as FlowIR;

  // Apply optimizations in order (order matters for some patterns)
  if (opts.optimizations.appendToSelect) {
    optimizedIR = optimizeAppendToSelect(optimizedIR, report, excludeSet);
  }

  if (opts.optimizations.singleSetVariableToCompose) {
    optimizedIR = optimizeSingleSetVariables(optimizedIR, report, excludeSet);
  }

  if (opts.optimizations.loopVariableToCompose) {
    optimizedIR = optimizeLoopVariables(optimizedIR, report, excludeSet);
  }

  // Parallelism analysis (warnings only, no transformations)
  if (opts.includeParallelismWarnings) {
    analyzeParallelismIssues(optimizedIR, report);
  }

  // Detect hardcoded values in connector actions (suggestions only, no auto-fix)
  detectHardcodedValues(optimizedIR, report);

  // Detect direct connections that should be converted to connection references
  detectDirectConnections(optimizedIR, report);

  return { ir: optimizedIR, report };
}

/**
 * Merges user options with defaults.
 */
function mergeOptions(options?: OptimizeOptions): Required<OptimizeOptions> {
  return {
    optimizations: {
      ...DEFAULT_OPTIMIZE_OPTIONS.optimizations,
      ...options?.optimizations,
    },
    includeParallelismWarnings: options?.includeParallelismWarnings ?? DEFAULT_OPTIMIZE_OPTIONS.includeParallelismWarnings,
    config: options?.config ?? DEFAULT_OPTIMIZE_OPTIONS.config,
    excludeActions: options?.excludeActions ?? DEFAULT_OPTIMIZE_OPTIONS.excludeActions,
  };
}
