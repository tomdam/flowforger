/**
 * Shared types for the DSL Language Service.
 * These types are environment-agnostic (work in both browser and Node.js).
 */

/** Position in a document (0-indexed) */
export interface Position {
  line: number;
  character: number;
}

/** Range in a document */
export interface Range {
  start: Position;
  end: Position;
}

/** Completion item kind */
export enum CompletionItemKind {
  Method = 'method',
  Property = 'property',
  Variable = 'variable',
  Function = 'function',
  Class = 'class',
  Interface = 'interface',
  Module = 'module',
  Keyword = 'keyword',
  Snippet = 'snippet',
  Text = 'text',
  Value = 'value',
  Enum = 'enum',
  EnumMember = 'enumMember',
  Constant = 'constant',
  Reference = 'reference',
}

/** Documentation content */
export interface Documentation {
  /** Plain text or markdown content */
  value: string;
  /** Whether the content is markdown */
  isTrusted?: boolean;
}

/** Completion item for autocomplete */
export interface CompletionItem {
  /** The label to display */
  label: string;
  /** The kind of completion item */
  kind: CompletionItemKind;
  /** A human-readable string with additional information */
  detail?: string;
  /** Documentation for the item */
  documentation?: string | Documentation;
  /** The text to insert when the completion is selected */
  insertText?: string;
  /** Whether the insertText is a snippet with placeholders */
  insertTextIsSnippet?: boolean;
  /** Sort order (lower = higher priority) */
  sortText?: string;
  /** Filter text used for matching */
  filterText?: string;
  /** A string that should be used when comparing this item with other items */
  preselect?: boolean;
  /** Additional text edits that are applied when selecting this completion */
  additionalTextEdits?: TextEdit[];
  /** Tags for this completion item (e.g., deprecated) */
  tags?: CompletionItemTag[];
}

export enum CompletionItemTag {
  Deprecated = 'deprecated',
}

/** Text edit operation */
export interface TextEdit {
  range: Range;
  newText: string;
}

/** Diagnostic severity */
export enum DiagnosticSeverity {
  Error = 'error',
  Warning = 'warning',
  Information = 'information',
  Hint = 'hint',
}

/** Diagnostic message */
export interface Diagnostic {
  /** The range at which the message applies */
  range: Range;
  /** The diagnostic's severity */
  severity: DiagnosticSeverity;
  /** The diagnostic's code (e.g., DSL001) */
  code?: string;
  /** A human-readable message */
  message: string;
  /** The source of the diagnostic (e.g., 'flowforger') */
  source?: string;
  /** Related information */
  relatedInformation?: DiagnosticRelatedInformation[];
}

/** Related diagnostic information */
export interface DiagnosticRelatedInformation {
  /** The location of the related information */
  location: {
    uri: string;
    range: Range;
  };
  /** The message of the related information */
  message: string;
}

/** Hover information */
export interface Hover {
  /** The contents of the hover */
  contents: string | Documentation;
  /** An optional range to highlight */
  range?: Range;
}

/** Location in a document */
export interface Location {
  uri: string;
  range: Range;
}

/** Symbol in a document (action, variable, etc.) */
export interface Symbol {
  name: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  detail?: string;
  children?: Symbol[];
}

export enum SymbolKind {
  Flow = 'flow',
  Trigger = 'trigger',
  Action = 'action',
  Variable = 'variable',
  Scope = 'scope',
  Condition = 'condition',
  Loop = 'loop',
}

/** Completion context - what triggered the completion */
export interface CompletionContext {
  /** How was completion triggered */
  triggerKind: CompletionTriggerKind;
  /** The trigger character (if triggerKind is TriggerCharacter) */
  triggerCharacter?: string;
}

export enum CompletionTriggerKind {
  /** Completion was triggered by typing */
  Invoked = 'invoked',
  /** Completion was triggered by a trigger character */
  TriggerCharacter = 'triggerCharacter',
  /** Completion was re-triggered as the current completion list is incomplete */
  TriggerForIncompleteCompletions = 'triggerForIncompleteCompletions',
}

/** Method signature for FlowContext methods */
export interface MethodSignature {
  name: string;
  description: string;
  parameters: ParameterInfo[];
  returnType: string;
  examples?: string[];
  category?: string;
  deprecated?: boolean;
  deprecationMessage?: string;
}

/** Parameter information */
export interface ParameterInfo {
  name: string;
  type: string;
  description: string;
  optional?: boolean;
  defaultValue?: string;
}

/** Connector operation */
export interface ConnectorOperation {
  connector: string;
  operation: string;
  description: string;
  parameters: ParameterInfo[];
}
