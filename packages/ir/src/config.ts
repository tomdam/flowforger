/**
 * FlowForger Global Configuration System
 *
 * This module defines the configuration schema for controlling behavior across
 * all FlowForger operations: parsing, generating, transforming, and emitting.
 *
 * Configuration can be provided via:
 * - flowforger.config.json file
 * - CLI command-line arguments
 * - Web app settings
 * - Programmatic API calls
 */

// ============================================================================
// Parser Configuration (Logic Apps JSON → IR)
// ============================================================================

export interface ParserConfig {
  /**
   * How to handle expressions during parsing.
   * - 'parse': Parse expressions into AST (may lose formatting)
   * - 'preserve': Preserve original expression strings for complex cases
   * - 'auto': Parse simple expressions, preserve multiline/complex ones
   * @default 'auto'
   */
  expressionHandling?: 'parse' | 'preserve' | 'auto';

  /**
   * Preserve original action/trigger names exactly (including spaces, special chars).
   * When false, names may be sanitized to valid TypeScript identifiers.
   * @default true
   */
  preserveActionNames?: boolean;

  /**
   * Preserve original variable names (including spaces, special chars).
   * When false, names may be sanitized to valid TypeScript identifiers.
   * @default true
   */
  preserveVariableNames?: boolean;

  /**
   * Preserve empty runAfter objects ({}) vs omitting them.
   * Some Logic Apps flows distinguish between runAfter: {} and no runAfter.
   * @default true
   */
  preserveEmptyRunAfter?: boolean;

  /**
   * Preserve empty else blocks in if statements.
   * @default true
   */
  preserveEmptyElse?: boolean;

  /**
   * Preserve empty default cases in switch statements.
   * @default true
   */
  preserveEmptyDefault?: boolean;

  /**
   * Skip these metadata fields when parsing actions.
   * Useful for ignoring auto-generated fields like 'operationMetadataId'.
   * @example ['operationMetadataId']
   * @default []
   */
  skipMetadataFields?: string[];

  /**
   * Skip preserving action names for these action kinds.
   * Actions with these kinds will get auto-generated default names during DSL generation.
   * Useful for variable initialization actions where you want default names.
   * Use lowercase kind names (e.g., 'initializevariable', 'setvariable').
   * @example ['initializevariable', 'setvariable']
   * @default []
   */
  skipActionNamesForKinds?: string[];
}

// ============================================================================
// Generator Configuration (IR → DSL)
// ============================================================================

export interface GeneratorConfig {
  /**
   * Whitespace style for function arguments in generated DSL.
   * - 'compact': No space after commas: func(a,b,c)
   * - 'spaced': Space after commas: func(a, b, c)
   * @default 'spaced'
   */
  argumentWhitespace?: 'compact' | 'spaced';

  /**
   * How to handle multiline expressions (containing \r\n).
   * - 'preserve': Keep original formatting via ctx.eval()
   * - 'flatten': Flatten to single line (may lose original formatting)
   * @default 'preserve'
   */
  multilineExpressions?: 'preserve' | 'flatten';

  /**
   * Include JSDoc annotations for metadata (@action, @runAfter, @retryPolicy, etc.)
   * @default true
   */
  includeJsDocAnnotations?: boolean;

  /**
   * Expression format preference for pure expressions.
   * - 'function': Use @function() format
   * - 'braced': Use @{function()} format where original used it
   * @default 'function'
   */
  expressionFormat?: 'function' | 'braced';

  /**
   * How to render action/trigger descriptions in generated DSL.
   * - 'jsdoc': Emit as `\/** @description ... *\/` (combines with other JSDoc tags)
   * - 'lineComment': Emit as `// ...` line(s) above the action; structural JSDoc tags
   *   (@action, @runAfter, etc.) still emit separately as JSDoc
   * @default 'lineComment'
   */
  descriptionStyle?: 'jsdoc' | 'lineComment';
}

// ============================================================================
// Transformer Configuration (DSL → IR)
// ============================================================================

export interface TransformerConfig {
  /**
   * How to emit string concatenation operations.
   * - 'concat': Always use concat() function
   * - 'plus': Use + operator (may be ambiguous with numeric addition)
   * @default 'concat'
   */
  concatStyle?: 'concat' | 'plus';

  /**
   * Argument separator style in emitted expressions.
   * @default ', '
   */
  argumentSeparator?: string;

  /**
   * Whether to flatten chained logical operators.
   * - true: a && b && c → and(a, b, c)
   * - false: a && b && c → and(and(a, b), c)
   * @default true
   */
  flattenLogicalOperators?: boolean;
}

// ============================================================================
// Emitter Configuration (IR → Logic Apps JSON)
// ============================================================================

export interface EmitterConnectionRef {
  /** Reference name for the connection (e.g., 'shared_sharepointonline') */
  referenceName?: string;
  /** API ID (e.g., '/providers/Microsoft.PowerApps/apis/shared_sharepointonline') */
  apiId?: string;
  /** Dataverse logical name for solution-aware flows */
  connectionReferenceLogicalName?: string;
  /** Runtime source ('embedded' or 'invoker') */
  runtimeSource?: string;
}

export interface EmitterConfig {
  /**
   * Connection references for connectors.
   * Maps connector names to their connection reference configuration.
   */
  connections?: Record<string, EmitterConnectionRef>;

  /**
   * Include operationMetadataId in output.
   * These are auto-generated IDs that change on each save.
   * @default false
   */
  includeMetadata?: boolean;

  /**
   * Include authentication parameters in connector actions.
   * @default true
   */
  includeAuthentication?: boolean;

  /**
   * Key ordering strategy for action definitions.
   * - 'alphabetical': Sort keys alphabetically
   * - 'logical': Use Power Automate's typical ordering (type, inputs, runAfter, etc.)
   * @default 'logical'
   */
  keyOrdering?: 'alphabetical' | 'logical';

  /**
   * How to handle empty runAfter objects.
   * - 'include': Include runAfter: {} for first actions in containers
   * - 'omit': Omit runAfter when empty
   * - 'preserve': Match the original format when known
   * @default 'preserve'
   */
  emptyRunAfter?: 'include' | 'omit' | 'preserve';
}

// ============================================================================
// Parity Check Configuration
// ============================================================================

export interface ParityConfig {
  /**
   * Ignore whitespace differences in expressions.
   * When true, "func(a, b)" and "func(a,b)" are considered equal.
   * @default false
   */
  ignoreWhitespace?: boolean;

  /**
   * Ignore differences in empty runAfter ({} vs missing).
   * @default false
   */
  ignoreEmptyRunAfter?: boolean;

  /**
   * Ignore metadata field differences (operationMetadataId, etc.).
   * @default true
   */
  ignoreMetadata?: boolean;

  /**
   * Ignore key ordering differences in JSON.
   * @default false
   */
  ignoreKeyOrder?: boolean;

  /**
   * Ignore trailing whitespace differences in string values.
   * @default false
   */
  ignoreTrailingWhitespace?: boolean;

  /**
   * Normalize function name case in expressions.
   * When true, "@Trim(x)" and "@trim(x)" are considered equal.
   * PA functions are case-insensitive, so this is purely cosmetic.
   * @default true
   */
  normalizeFunctionCase?: boolean;

  /**
   * Normalize number formatting.
   * When true, 100.00 and 100 are considered equal.
   * @default true
   */
  normalizeNumbers?: boolean;

  /**
   * Normalize multiple consecutive spaces to single space.
   * When true, "a  b" and "a b" are considered equal.
   * @default true
   */
  normalizeSpaces?: boolean;

  /**
   * Normalize item()/items('LoopName') references in expressions.
   * When true, items('Apply_to_each') and item() are considered equal.
   * The DSL always expands item() to items('LoopName') for semantic correctness,
   * but both forms are equivalent in Power Automate.
   * @default true
   */
  normalizeItemFunction?: boolean;
}

// ============================================================================
// Logging Configuration
// ============================================================================

export interface LoggingConfig {
  /**
   * Enable verbose logging of conversion steps.
   * When true, logs messages like "[FlowForger] Converting: DSL → IR"
   * @default false
   */
  verbose?: boolean;
}

// ============================================================================
// Main Configuration Interface
// ============================================================================

/**
 * FlowForger Global Configuration
 * Controls behavior across parsing, transforming, generating, and emitting.
 */
export interface FlowForgerConfig {
  /**
   * Logging options
   */
  logging?: LoggingConfig;

  /**
   * Parser options (Logic Apps JSON → IR)
   */
  parser?: ParserConfig;

  /**
   * Generator options (IR → DSL)
   */
  generator?: GeneratorConfig;

  /**
   * Transformer options (DSL → IR)
   */
  transformer?: TransformerConfig;

  /**
   * Emitter options (IR → Logic Apps JSON)
   */
  emitter?: EmitterConfig;

  /**
   * Parity checking options
   */
  parity?: ParityConfig;
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default logging configuration.
 */
export const DEFAULT_LOGGING_CONFIG: Required<LoggingConfig> = {
  verbose: false,
};

/**
 * Default parser configuration.
 */
export const DEFAULT_PARSER_CONFIG: Required<ParserConfig> = {
  expressionHandling: 'auto',
  preserveActionNames: true,
  preserveVariableNames: true,
  preserveEmptyRunAfter: true,
  preserveEmptyElse: true,
  preserveEmptyDefault: true,
  skipMetadataFields: [],
  skipActionNamesForKinds: [],
};

/**
 * Default generator configuration.
 */
export const DEFAULT_GENERATOR_CONFIG: Required<GeneratorConfig> = {
  argumentWhitespace: 'spaced',
  multilineExpressions: 'preserve',
  includeJsDocAnnotations: true,
  expressionFormat: 'function',
  descriptionStyle: 'lineComment',
};

/**
 * Default transformer configuration.
 */
export const DEFAULT_TRANSFORMER_CONFIG: Required<TransformerConfig> = {
  concatStyle: 'concat',
  argumentSeparator: ', ',
  flattenLogicalOperators: true,
};

/**
 * Default emitter configuration.
 */
export const DEFAULT_EMITTER_CONFIG: Required<Omit<EmitterConfig, 'connections'>> & Pick<EmitterConfig, 'connections'> = {
  connections: undefined,
  includeMetadata: false,
  includeAuthentication: true,
  keyOrdering: 'logical',
  emptyRunAfter: 'preserve',
};

/**
 * Default parity configuration.
 */
export const DEFAULT_PARITY_CONFIG: Required<ParityConfig> = {
  ignoreWhitespace: false,
  ignoreEmptyRunAfter: false,
  ignoreMetadata: true,
  ignoreKeyOrder: false,
  ignoreTrailingWhitespace: false,
  normalizeFunctionCase: true,
  normalizeNumbers: true,
  normalizeSpaces: true,
  normalizeItemFunction: true,
};

/**
 * Complete default configuration with sensible values.
 */
export const DEFAULT_CONFIG: FlowForgerConfig = {
  logging: DEFAULT_LOGGING_CONFIG,
  parser: DEFAULT_PARSER_CONFIG,
  generator: DEFAULT_GENERATOR_CONFIG,
  transformer: DEFAULT_TRANSFORMER_CONFIG,
  emitter: DEFAULT_EMITTER_CONFIG,
  parity: DEFAULT_PARITY_CONFIG,
};

// ============================================================================
// Configuration Utilities
// ============================================================================

/**
 * Deep merge two objects, with source values overriding target values.
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T> | undefined): T {
  if (!source) return target;

  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (sourceValue === undefined) {
      continue;
    }

    if (
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      // Recursively merge nested objects
      result[key] = deepMerge(targetValue, sourceValue as any);
    } else {
      // Directly assign primitive values and arrays
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

/**
 * Merge user configuration with defaults.
 * User values override defaults at any level.
 *
 * @param userConfig - Partial configuration from user
 * @param base - Base configuration to merge into (defaults to DEFAULT_CONFIG)
 * @returns Complete configuration with all values filled in
 */
export function mergeConfig(
  userConfig: Partial<FlowForgerConfig> | undefined,
  base: FlowForgerConfig = DEFAULT_CONFIG
): FlowForgerConfig {
  if (!userConfig) return base;

  return {
    logging: deepMerge(base.logging ?? DEFAULT_LOGGING_CONFIG, userConfig.logging),
    parser: deepMerge(base.parser ?? DEFAULT_PARSER_CONFIG, userConfig.parser),
    generator: deepMerge(base.generator ?? DEFAULT_GENERATOR_CONFIG, userConfig.generator),
    transformer: deepMerge(base.transformer ?? DEFAULT_TRANSFORMER_CONFIG, userConfig.transformer),
    emitter: deepMerge(base.emitter ?? DEFAULT_EMITTER_CONFIG, userConfig.emitter),
    parity: deepMerge(base.parity ?? DEFAULT_PARITY_CONFIG, userConfig.parity),
  };
}

/**
 * Get the logging config from a FlowForgerConfig, with defaults filled in.
 */
export function getLoggingConfig(config?: FlowForgerConfig): Required<LoggingConfig> {
  return deepMerge(DEFAULT_LOGGING_CONFIG, config?.logging);
}

/**
 * Get the parser config from a FlowForgerConfig, with defaults filled in.
 */
export function getParserConfig(config?: FlowForgerConfig): Required<ParserConfig> {
  return deepMerge(DEFAULT_PARSER_CONFIG, config?.parser);
}

/**
 * Get the generator config from a FlowForgerConfig, with defaults filled in.
 */
export function getGeneratorConfig(config?: FlowForgerConfig): Required<GeneratorConfig> {
  return deepMerge(DEFAULT_GENERATOR_CONFIG, config?.generator);
}

/**
 * Get the transformer config from a FlowForgerConfig, with defaults filled in.
 */
export function getTransformerConfig(config?: FlowForgerConfig): Required<TransformerConfig> {
  return deepMerge(DEFAULT_TRANSFORMER_CONFIG, config?.transformer);
}

/**
 * Get the emitter config from a FlowForgerConfig, with defaults filled in.
 */
export function getEmitterConfig(config?: FlowForgerConfig): EmitterConfig {
  return deepMerge(DEFAULT_EMITTER_CONFIG, config?.emitter);
}

/**
 * Get the parity config from a FlowForgerConfig, with defaults filled in.
 */
export function getParityConfig(config?: FlowForgerConfig): Required<ParityConfig> {
  return deepMerge(DEFAULT_PARITY_CONFIG, config?.parity);
}

/**
 * Validate a configuration object.
 * Returns an array of error messages, or empty array if valid.
 */
export function validateConfig(config: Partial<FlowForgerConfig>): string[] {
  const errors: string[] = [];

  // Validate parser config
  if (config.parser) {
    const validExpressionHandling = ['parse', 'preserve', 'auto'];
    if (config.parser.expressionHandling && !validExpressionHandling.includes(config.parser.expressionHandling)) {
      errors.push(`Invalid parser.expressionHandling: ${config.parser.expressionHandling}. Must be one of: ${validExpressionHandling.join(', ')}`);
    }
  }

  // Validate generator config
  if (config.generator) {
    const validWhitespace = ['compact', 'spaced'];
    if (config.generator.argumentWhitespace && !validWhitespace.includes(config.generator.argumentWhitespace)) {
      errors.push(`Invalid generator.argumentWhitespace: ${config.generator.argumentWhitespace}. Must be one of: ${validWhitespace.join(', ')}`);
    }

    const validMultiline = ['preserve', 'flatten'];
    if (config.generator.multilineExpressions && !validMultiline.includes(config.generator.multilineExpressions)) {
      errors.push(`Invalid generator.multilineExpressions: ${config.generator.multilineExpressions}. Must be one of: ${validMultiline.join(', ')}`);
    }
  }

  // Validate transformer config
  if (config.transformer) {
    const validConcatStyle = ['concat', 'plus'];
    if (config.transformer.concatStyle && !validConcatStyle.includes(config.transformer.concatStyle)) {
      errors.push(`Invalid transformer.concatStyle: ${config.transformer.concatStyle}. Must be one of: ${validConcatStyle.join(', ')}`);
    }
  }

  // Validate emitter config
  if (config.emitter) {
    const validKeyOrdering = ['alphabetical', 'logical'];
    if (config.emitter.keyOrdering && !validKeyOrdering.includes(config.emitter.keyOrdering)) {
      errors.push(`Invalid emitter.keyOrdering: ${config.emitter.keyOrdering}. Must be one of: ${validKeyOrdering.join(', ')}`);
    }

    const validEmptyRunAfter = ['include', 'omit', 'preserve'];
    if (config.emitter.emptyRunAfter && !validEmptyRunAfter.includes(config.emitter.emptyRunAfter)) {
      errors.push(`Invalid emitter.emptyRunAfter: ${config.emitter.emptyRunAfter}. Must be one of: ${validEmptyRunAfter.join(', ')}`);
    }
  }

  return errors;
}

/**
 * Parse a configuration from a JSON object (e.g., from flowforger.config.json).
 * Supports the global/environments structure.
 */
export function parseConfigFromJson(
  json: Record<string, any>,
  environment?: string
): FlowForgerConfig {
  // Check if it has the global/environments structure
  if (json.global || json.environments) {
    const globalConfig = json.global || {};
    const envConfig = environment && json.environments?.[environment] ? json.environments[environment] : {};

    // Merge environment-specific config over global config
    return mergeConfig(envConfig, mergeConfig(globalConfig, DEFAULT_CONFIG));
  }

  // Direct configuration object
  return mergeConfig(json as Partial<FlowForgerConfig>, DEFAULT_CONFIG);
}
