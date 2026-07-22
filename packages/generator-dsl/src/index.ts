/**
 * @flowforger/generator-dsl
 *
 * This package has been deprecated in favor of @flowforger/dsl-native.
 * It now re-exports the native DSL generator for backwards compatibility.
 *
 * Use @flowforger/dsl-native directly for new code:
 * import { parseLogicAppsToIR, generateNativeDslFromIR } from '@flowforger/dsl-native';
 */

// Re-export native DSL generators for backwards compatibility
export { generateNativeDslFromIR as generateDslFromIR } from '@flowforger/dsl-native';
export { generateNativeDslFromIR, GeneratorOptions } from '@flowforger/dsl-native';

// Re-export Logic Apps JSON parser
export { parseLogicAppsToIR, ParseOptions } from '@flowforger/dsl-native';

// Note: generateDslFactoryFromLogicApps has been removed.
// The native DSL approach doesn't use runtime factories.
// Use transformCode from @flowforger/dsl-native to transform native DSL code to IR.

// Note: generateNativeDslFromLogicApps has been removed.
// Use parseLogicAppsToIR() + generateNativeDslFromIR() instead for the
// canonical Logic Apps JSON -> IR -> DSL conversion path.
