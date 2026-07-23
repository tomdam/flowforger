/**
 * DSL Diagnostic Codes and Messages.
 * These codes are used for error reporting in the editor.
 */

/**
 * Diagnostic severity levels.
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * Diagnostic code definition.
 */
export interface DiagnosticCode {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  /** Function to format the message with parameters */
  format?: (...args: string[]) => string;
}

/**
 * All DSL diagnostic codes.
 */
export const DiagnosticCodes = {
  // Flow Structure Errors (DSL001-DSL003)
  DSL001: {
    code: 'DSL001',
    severity: 'error' as DiagnosticSeverity,
    message: 'Missing @Flow decorator on class',
    format: () => 'Class must have @Flow decorator to be a valid flow definition',
  },
  DSL002: {
    code: 'DSL002',
    severity: 'error' as DiagnosticSeverity,
    message: 'Missing trigger method',
    format: () =>
      'Flow must have a trigger method decorated with @HttpTrigger, @ManualTrigger, @RecurrenceTrigger, or @ConnectorTrigger',
  },
  DSL003: {
    code: 'DSL003',
    severity: 'error' as DiagnosticSeverity,
    message: 'Missing @Action decorator',
    format: () => 'Flow must have a method decorated with @Action()',
  },

  // Reference Errors (DSL004-DSL005)
  DSL004: {
    code: 'DSL004',
    severity: 'error' as DiagnosticSeverity,
    message: "Invalid action reference: '{0}'",
    format: (name: string) => `Action '${name}' is not declared before this reference`,
  },
  DSL005: {
    code: 'DSL005',
    severity: 'error' as DiagnosticSeverity,
    message: "Invalid variable reference: '{0}'",
    format: (name: string) => `Variable '${name}' is not declared before this reference`,
  },

  // Unused Symbols (DSL007)
  DSL007: {
    code: 'DSL007',
    severity: 'warning' as DiagnosticSeverity,
    message: "Unused variable: '{0}'",
    format: (name: string) => `Variable '${name}' is declared but never used`,
  },

  // Duplicate Declarations (DSL008)
  DSL008: {
    code: 'DSL008',
    severity: 'error' as DiagnosticSeverity,
    message: "Duplicate action name: '{0}'",
    format: (name: string, line: string) =>
      `Action '${name}' is already declared at line ${line}. Action names must be unique.`,
  },

  // Best Practices (DSL009)
  DSL009: {
    code: 'DSL009',
    severity: 'info' as DiagnosticSeverity,
    message: 'Consider using typed connector syntax',
    format: (connector: string, operation: string) =>
      `Consider using ctx.connectors.${connector}.${operation}() for better type safety`,
  },

  // Validation Errors (DSL010)
  DSL010: {
    code: 'DSL010',
    severity: 'error' as DiagnosticSeverity,
    message: 'FlowIR validation error',
    format: (message: string) => `FlowIR validation failed: ${message}`,
  },

  // Loop Errors (DSL011-DSL012)
  DSL011: {
    code: 'DSL011',
    severity: 'error' as DiagnosticSeverity,
    message: "Invalid loop reference: '{0}'",
    format: (name: string) => `Loop '${name}' does not exist`,
  },
  DSL012: {
    code: 'DSL012',
    severity: 'warning' as DiagnosticSeverity,
    message: 'item() used outside of loop',
    format: () => 'ctx.item() should only be used inside a for...of loop',
  },

  // Parameter Errors (DSL013)
  DSL013: {
    code: 'DSL013',
    severity: 'error' as DiagnosticSeverity,
    message: "Missing required parameter: '{0}'",
    format: (param: string, method: string) =>
      `Method '${method}' requires parameter '${param}'`,
  },

  // Variable Initialization Errors (DSL014)
  DSL014: {
    code: 'DSL014',
    severity: 'error' as DiagnosticSeverity,
    message: 'Variable initialization inside control structure',
    format: (name: string) =>
      `Variable '${name}' cannot be initialized inside a control structure (if, for, scope). Move the variable declaration to the root level of the action method.`,
  },

  // Undefined Parameter Reference (DSL015)
  DSL015: {
    code: 'DSL015',
    severity: 'error' as DiagnosticSeverity,
    message: "Undefined parameter: '{0}'",
    format: (name: string, defined?: string) =>
      defined
        ? `Parameter '${name}' is not defined. Defined parameters: ${defined}`
        : `Parameter '${name}' is not defined. Add it to ctx.flow.parameters in the constructor.`,
  },

  // Undefined Connection Reference (DSL016)
  DSL016: {
    code: 'DSL016',
    severity: 'error' as DiagnosticSeverity,
    message: "Undefined connection reference: '{0}'",
    format: (name: string, defined?: string) =>
      defined
        ? `Connection reference '${name}' is not defined. Defined references: ${defined}`
        : `Connection reference '${name}' is not defined. Add it to ctx.flow.connectionReferences in the constructor.`,
  },

  // Missing Await on Action Call (DSL017)
  DSL017: {
    code: 'DSL017',
    severity: 'error' as DiagnosticSeverity,
    message: "Missing 'await' on action call",
    format: (callText: string) =>
      `Action call '${callText}' is missing 'await' and will be omitted from the compiled flow. Add 'await' before the call.`,
  },

  // Return Statement in Action Method (DSL018)
  DSL018: {
    code: 'DSL018',
    severity: 'error' as DiagnosticSeverity,
    message: "'return' statement has no effect in flow",
    format: () =>
      `'return' statements are ignored in the flow — subsequent actions will still execute. Use 'await ctx.terminate()' to end the flow.`,
  },

  // Multiple @Action Methods (DSL019)
  DSL019: {
    code: 'DSL019',
    severity: 'error' as DiagnosticSeverity,
    message: 'Multiple @Action methods found',
    format: (firstName: string) =>
      `Only the first @Action method ('${firstName}') is compiled. Additional @Action methods are silently ignored. Merge all action logic into a single @Action method.`,
  },

  // Unsupported Statement Types (DSL020)
  DSL020: {
    code: 'DSL020',
    severity: 'warning' as DiagnosticSeverity,
    message: 'Unsupported statement in flow',
    format: (statementType: string) =>
      `'${statementType}' statements have no Logic Apps equivalent and will be ignored in the compiled flow.`,
  },

  // Invalid @runAfter Status (DSL021)
  DSL021: {
    code: 'DSL021',
    severity: 'error' as DiagnosticSeverity,
    message: "Invalid @runAfter status: '{0}'",
    format: (status: string) =>
      `'${status}' is not a valid runAfter status. Valid values: Succeeded, Failed, Skipped, TimedOut.`,
  },

  // @runAfter References Non-Existent Action (DSL022)
  DSL022: {
    code: 'DSL022',
    severity: 'error' as DiagnosticSeverity,
    message: "Invalid @runAfter action reference: '{0}'",
    format: (name: string) =>
      `Action '${name}' referenced in @runAfter is not declared in this flow.`,
  },

  // Empty @Flow Name (DSL023)
  DSL023: {
    code: 'DSL023',
    severity: 'error' as DiagnosticSeverity,
    message: 'Empty flow name',
    format: () =>
      `@Flow name must not be empty. Provide a non-empty string as the flow name.`,
  },

  // Invalid @type JSDoc Value (DSL024)
  DSL024: {
    code: 'DSL024',
    severity: 'warning' as DiagnosticSeverity,
    message: "Invalid @type value: '{0}'",
    format: (value: string) =>
      `'${value}' is not a valid @type value. Valid values: scope, if, foreach, switch, until, dountil, case.`,
  },

  // const Variable Won't Generate InitializeVariable (DSL025)
  DSL025: {
    code: 'DSL025',
    severity: 'warning' as DiagnosticSeverity,
    message: "'const' variable will not generate InitializeVariable",
    format: (name: string) =>
      `Variable '${name}' declared with 'const' will not generate an InitializeVariable action. Use 'let' to create a Logic Apps variable.`,
  },

  // Unknown ctx Method (DSL026)
  DSL026: {
    code: 'DSL026',
    severity: 'info' as DiagnosticSeverity,
    message: "Unknown ctx method: '{0}'",
    format: (methodName: string) =>
      `'ctx.${methodName}()' is not a recognized FlowContext method. It will be passed through as '@${methodName}()'. Check for typos.`,
  },

  // Malformed JSDoc JSON Annotation (DSL027)
  DSL027: {
    code: 'DSL027',
    severity: 'warning' as DiagnosticSeverity,
    message: "Malformed JSON in @{0}",
    format: (annotation: string) =>
      `@${annotation} contains invalid JSON and will be ignored. Check the JSON syntax.`,
  },

  // Quoted Spread Operator (DSL028)
  DSL028: {
    code: 'DSL028',
    severity: 'error' as DiagnosticSeverity,
    message: "Quoted spread operator: '...{0}'",
    format: (name: string) =>
      `'"...${name}"' is a string literal, not a spread of the variable. Did you mean '...${name}' (unquoted) or '${name}.push(value)' to append?`,
  },

  // Self-Referential Array Reassignment (DSL029)
  DSL029: {
    code: 'DSL029',
    severity: 'warning' as DiagnosticSeverity,
    message: "Self-referential reassignment of '{0}' — use .push()",
    format: (name: string) =>
      `Reassigning '${name}' to an array that references itself generates SetVariable, not AppendToArrayVariable. Use '${name}.push(value)' to append instead.`,
  },

  // Duplicate Variable Declaration (DSL030)
  DSL030: {
    code: 'DSL030',
    severity: 'error' as DiagnosticSeverity,
    message: "Duplicate variable declaration: '{0}'",
    format: (name: string, line: string) =>
      `Variable '${name}' is already declared at line ${line}. FlowForger variables map to Power Automate InitializeVariable actions, which must be unique per variable name.`,
  },

  // Description Exceeds Power Automate Limit (DSL031)
  DSL031: {
    code: 'DSL031',
    severity: 'error' as DiagnosticSeverity,
    message: 'Description exceeds 255 characters',
    format: (length: string) =>
      `This comment becomes the action's description in Power Automate, which allows at most 255 characters (currently ${length}). Shorten the comment.`,
  },
} as const;

/**
 * Get a diagnostic code by its ID.
 */
export function getDiagnosticCode(code: keyof typeof DiagnosticCodes): DiagnosticCode {
  return DiagnosticCodes[code];
}

/**
 * Format a diagnostic message with parameters.
 */
export function formatDiagnosticMessage(
  code: keyof typeof DiagnosticCodes,
  ...args: string[]
): string {
  const diagnostic = DiagnosticCodes[code];
  if (diagnostic.format) {
    // Apply the format function with the provided arguments
    return (diagnostic.format as (...args: string[]) => string)(...args);
  }
  return diagnostic.message;
}

/**
 * Get all diagnostic codes as an array.
 */
export function getAllDiagnosticCodes(): DiagnosticCode[] {
  return Object.values(DiagnosticCodes);
}
