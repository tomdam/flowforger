/**
 * Test script for template literal round-trip
 */

import {
  parseStringValue,
  parseStringToTemplateLiteral,
  isMixedExpressionString,
} from '../src/generator/expression-parser.js';
import {
  transformTemplateStringInline,
  createTransformContext,
} from '../src/transformer/expression-transformer.js';
import { Project } from 'ts-morph';

function parseExpression(code: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('test.ts', `const x = ${code};`);
  const varDecl = sourceFile.getVariableDeclarations()[0];
  return varDecl.getInitializer()!;
}

console.log('=== Testing Template Literal Implementation ===\n');

// Test 1: Detect mixed expression strings
console.log('1. Testing isMixedExpressionString():');
const testCases = [
  { input: 'Hello @{parameters("Name")}, your order is ready.', expected: true },
  { input: '@body("GetUser")', expected: false },
  { input: '@{parameters("Name")}', expected: false },
  { input: 'Hello world', expected: false },
  { input: 'Status: @{body("GetStatus").status} - Count: @{variables("count")}', expected: true },
];

for (const { input, expected } of testCases) {
  const result = isMixedExpressionString(input);
  const status = result === expected ? '✓' : '✗';
  console.log(`  ${status} "${input.substring(0, 40)}..." -> ${result} (expected ${expected})`);
}

// Test 2: Parse PA string to TypeScript template literal
console.log('\n2. Testing parseStringToTemplateLiteral():');
const parseTests = [
  'Hello @{parameters("Name")}, your order is ready.',
  'Status: @{body("GetStatus").status}',
  'Count is @{variables("count")} items',
];

for (const input of parseTests) {
  const result = parseStringToTemplateLiteral(input);
  console.log(`  Input:  "${input}"`);
  console.log(`  Output: ${result.code}`);
  console.log(`  Success: ${result.success}\n`);
}

// Test 3: Parse using smart parseStringValue
console.log('3. Testing parseStringValue() (smart parser):');
const smartTests = [
  'Hello @{parameters("Name")}!',  // Mixed -> template literal
  '@body("GetUser")',              // Pure expression -> ctx method
  'Plain text',                    // Plain string -> quoted string
];

for (const input of smartTests) {
  const result = parseStringValue(input);
  console.log(`  Input:  "${input}"`);
  console.log(`  Output: ${result.code}`);
  console.log('');
}

// Test 4: Transform template literal back to PA string
console.log('4. Testing transformTemplateStringInline() (TS -> PA):');
const ctx = createTransformContext();

const templateTests = [
  '`Hello ${ctx.parameters("Name")}, your order is ready.`',
  '`Status: ${ctx.body("GetStatus").status}`',
  '`Count is ${ctx.variables("count")} items`',
];

for (const template of templateTests) {
  const expr = parseExpression(template);
  const result = transformTemplateStringInline(expr, ctx);
  console.log(`  Input:  ${template}`);
  console.log(`  Output: "${result}"`);
  console.log('');
}

// Test 5: Full round-trip
console.log('5. Testing full round-trip (PA -> TS -> PA):');
const roundTripTests = [
  'Hello @{parameters("Name")}, your order @{body("GetOrder").id} is ready.',
  'Status: @{body("GetStatus").status} - Updated: @{utcNow()}',
];

// Normalize quotes for comparison (both ' and " are valid in PA)
function normalizeQuotes(s: string): string {
  return s.replace(/"/g, "'");
}

for (const original of roundTripTests) {
  // PA -> TS template literal
  const tsCode = parseStringToTemplateLiteral(original);
  console.log(`  Original PA: "${original}"`);
  console.log(`  TS Code:     ${tsCode.code}`);

  // TS template literal -> PA
  const expr = parseExpression(tsCode.code);
  const backToPA = transformTemplateStringInline(expr, ctx);
  console.log(`  Back to PA:  "${backToPA}"`);

  // Compare normalized (both ' and " are valid in PA expressions)
  const normalizedOriginal = normalizeQuotes(original);
  const normalizedResult = normalizeQuotes(backToPA);
  const match = normalizedOriginal === normalizedResult ? '✓ MATCH (semantically)' : '✗ MISMATCH';
  console.log(`  Result: ${match}\n`);
}

console.log('=== Tests Complete ===');
