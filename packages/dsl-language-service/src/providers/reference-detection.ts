/**
 * String reference detection for DSL code.
 * Detects when a cursor position is inside a string argument to
 * reference functions like ctx.variables('Name'), ctx.body('Name'), etc.
 */

/**
 * A detected string reference in DSL code.
 */
export interface StringReference {
  /** What kind of symbol is being referenced */
  type: 'variable' | 'action' | 'parameter' | 'loop';
  /** The name inside the string */
  name: string;
  /** Column of first char of name (0-indexed) */
  nameStart: number;
  /** Column after last char of name (0-indexed) */
  nameEnd: number;
}

/**
 * Patterns that resolve to a specific reference type.
 *
 * We use a function-name based approach: match the function name, then extract
 * the string argument and check if the cursor falls within it.
 */
const REFERENCE_PATTERNS: Array<{ funcNames: string[]; type: StringReference['type'] }> = [
  // Variable read-side
  { funcNames: ['variables'], type: 'variable' },
  // Variable write-side
  { funcNames: ['setVariable', 'appendToArrayVariable', 'appendToStringVariable'], type: 'variable' },
  // Action references
  { funcNames: ['body', 'outputs', 'actions'], type: 'action' },
  // Parameter references
  { funcNames: ['parameters'], type: 'parameter' },
  // Loop references
  { funcNames: ['items'], type: 'loop' },
];

/**
 * Detect if the cursor is inside a string reference on the given line.
 *
 * @param lineText - The full text of the line
 * @param column - 0-indexed cursor column
 * @returns The detected reference, or null if cursor is not on a string reference
 */
export function detectStringReference(lineText: string, column: number): StringReference | null {
  for (const pattern of REFERENCE_PATTERNS) {
    for (const funcName of pattern.funcNames) {
      // Build regex: optional ctx. prefix, function name, opening paren, optional whitespace, quote
      // We need to find all occurrences on the line (multiple references possible)
      const regex = new RegExp(
        `(?:ctx\\.)?${funcName}\\s*\\(\\s*(['"])([^'"]*?)\\1`,
        'g'
      );

      let match;
      while ((match = regex.exec(lineText)) !== null) {
        // match[2] is the string content
        // Find where the string content starts: after the opening quote
        const fullMatch = match[0];
        const quote = match[1];
        const name = match[2];

        // The string content starts at: match.index + (everything before the opening quote) + 1
        const quoteIndex = match.index + fullMatch.indexOf(quote);
        const nameStart = quoteIndex + 1;
        const nameEnd = nameStart + name.length;

        // Check if cursor is within the name (inclusive start, exclusive end)
        if (column >= nameStart && column < nameEnd) {
          return {
            type: pattern.type,
            name,
            nameStart,
            nameEnd,
          };
        }
      }
    }
  }

  // Check for @runAfter in JSDoc comments
  // Format: @runAfter ActionName: Status1, Status2
  // or:     @runAfter "ActionName": Status1, Status2
  const runAfterQuotedRegex = /@runAfter\s+"([^"]+)"/g;
  let raMatch;
  while ((raMatch = runAfterQuotedRegex.exec(lineText)) !== null) {
    const name = raMatch[1];
    const nameStart = raMatch.index + raMatch[0].indexOf('"') + 1;
    const nameEnd = nameStart + name.length;
    if (column >= nameStart && column < nameEnd) {
      return { type: 'action', name, nameStart, nameEnd };
    }
  }

  const runAfterBareRegex = /@runAfter\s+([^":\s@*][^:@*]*?):\s/g;
  while ((raMatch = runAfterBareRegex.exec(lineText)) !== null) {
    const name = raMatch[1].trim();
    // Find where the name starts in the match
    const afterTag = raMatch[0].indexOf(raMatch[1]);
    const nameStart = raMatch.index + afterTag;
    const nameEnd = nameStart + name.length;
    if (column >= nameStart && column < nameEnd) {
      return { type: 'action', name, nameStart, nameEnd };
    }
  }

  return null;
}
