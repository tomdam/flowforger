export type { ExprNode, PathSeg, TemplatePart } from './ast.js';
export { walkCalls } from './ast.js';
export type { Token } from './lexer.js';
export { tokenize, LexError } from './lexer.js';
export {
  ParseError,
  parseExpression,
  tryParseExpression,
  parseTemplate,
  parseTemplateStrict,
  parseTemplateWithDiagnostics,
  type TemplateError,
} from './parser.js';
export { KNOWN_FUNCTIONS } from './functions-catalogue.js';
