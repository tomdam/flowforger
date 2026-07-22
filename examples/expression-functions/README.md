# Expression Functions Example

This example demonstrates the comprehensive expression functions in FlowForger that allow workflows to reference action outputs, manipulate strings, perform math operations, and work with collections.

## Expression Functions

### Action Reference Functions

- **`actions('actionName')`** - Get complete action data (status, outputs, error)
  ```typescript
  "@actions('GetUserData').status" // Returns: "Succeeded"
  ```

- **`body('actionName')`** - Get action output body
  ```typescript
  "@body('GetUserData').user.name" // Returns: "John Doe"
  ```

- **`outputs('actionName')`** - Alias for body()
  ```typescript
  "@outputs('GetUserData').user.email" // Returns: "john@example.com"
  ```

### Trigger Reference Functions

- **`trigger()`** - Get trigger data object
  ```typescript
  "@trigger().body" // Returns trigger input
  ```

- **`triggerBody()`** - Get trigger body directly
  ```typescript
  "@triggerBody()" // Returns trigger input
  ```

- **`triggerOutputs()`** - Alias for triggerBody()
  ```typescript
  "@triggerOutputs().message" // Access trigger properties
  ```

### Workflow Reference Functions

- **`workflow()`** - Get workflow metadata
  ```typescript
  "@workflow().name" // Returns: "expression-functions-demo"
  ```

- **`parameters('paramName')`** - Get workflow parameter
  ```typescript
  "@parameters('myParam')" // Returns parameter definition/value
  ```

### String Functions

- **`indexOf(text, searchText)`** - Find position of substring
  ```typescript
  "@indexOf('Hello World', 'World')" // Returns: 6
  ```

- **`lastIndexOf(text, searchText)`** - Find last position of substring
  ```typescript
  "@lastIndexOf('Hello World World', 'World')" // Returns: 12
  ```

- **`guid()`** - Generate a unique GUID
  ```typescript
  "@guid()" // Returns: "3414a5fd-fef5-4405-a5ca-67bfca312b6e"
  ```

- **`base64(text)`** - Base64 encode a string
  ```typescript
  "@base64('Hello World')" // Returns: "SGVsbG8gV29ybGQ="
  ```

- **`base64ToString(base64)`** - Decode a base64 string
  ```typescript
  "@base64ToString('SGVsbG8gV29ybGQ=')" // Returns: "Hello World"
  ```

- **`uriComponent(text)`** - URL encode a string
  ```typescript
  "@uriComponent('Hello World!')" // Returns: "Hello%20World%21"
  ```

- **`uriComponentToString(encoded)`** - URL decode a string
  ```typescript
  "@uriComponentToString('Hello%20World%21')" // Returns: "Hello World!"
  ```

### Math Functions

- **`int(value)`** - Convert to integer (truncate)
  ```typescript
  "@int(3.7)" // Returns: 3
  ```

- **`float(value)`** - Convert to float
  ```typescript
  "@float('3.14')" // Returns: 3.14
  ```

- **`abs(number)`** - Absolute value
  ```typescript
  "@abs(-5)" // Returns: 5
  ```

- **`ceil(number)`** - Round up
  ```typescript
  "@ceil(3.2)" // Returns: 4
  ```

- **`floor(number)`** - Round down
  ```typescript
  "@floor(3.9)" // Returns: 3
  ```

- **`round(number)`** - Round to nearest integer
  ```typescript
  "@round(3.6)" // Returns: 4
  ```

### Collection Functions

- **`createArray(value1, value2, ...)`** - Create an array from values
  ```typescript
  "@createArray('a', 'b', 'c')" // Returns: ["a","b","c"]
  ```

- **`range(start, count)`** - Generate a range of integers
  ```typescript
  "@range(1, 5)" // Returns: [1,2,3,4,5]
  ```

## Property Path Navigation

All expression functions support dot notation for accessing nested properties:

```typescript
"@body('GetUserData').user.name"          // Access nested object
"@actions('GetData').outputs.items[0]"    // Access array elements
"@trigger().body.request.headers"         // Access nested paths
```

## Complex Expressions

Functions can be nested and combined:

```typescript
"@concat(base64ToString('SGVsbG8='), ' ', 'World')"  // "Hello World"
"@add(abs(-10), ceil(2.3))"                          // 13
"@length(createArray(1, 2, 3, 4, 5))"                // 5
"@indexOf(toLower('HELLO WORLD'), 'world')"          // 6
```

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# Run locally (compiles DSL → IR on the fly)
npx flowforger run examples/expression-functions/flow.ff.ts

# Or from local source (after `npm run build` at repo root)
node packages/cli/dist/index.js run examples/expression-functions/flow.ff.ts
```

## Example Flow

The example flow demonstrates:

1. **Action output references**: Getting data from previous actions
2. **Property path navigation**: Accessing nested object properties
3. **Action status checking**: Conditional logic based on action success/failure
4. **Trigger data access**: Using data from the workflow trigger
5. **Parameter access**: Reading workflow parameters
6. **Complex expressions**: Combining multiple functions with string operations

## Expected Output

When you run the flow, you should see:

- `ExtractUserName`: "John Doe" (from action output property path)
- `CheckStatus`: "Succeeded" (from action status)
- `GetUserEmail`: "john@example.com" (using outputs() alias)
- `GetTriggerData`: Full trigger object
- `AgeMessage`: "User is older than 25: John Doe" (conditional + concat)
- `SuccessMessage`: "'GetUserData action succeeded!'" (conditional based on action status)

## Implementation Details

These expression functions are now supported in:

- **Engine** (`@flowforger/engine`): Evaluates expressions during local execution
- **DSL** (`@flowforger/dsl-native`): Supports native TypeScript expressions that transform to Power Automate expressions
- **Emitter** (`@flowforger/emitter-logicapps`): Preserves expressions when generating Logic Apps JSON
- **Generator** (`@flowforger/dsl-native`): `generateNativeDslFromLogicApps()` preserves expressions when reverse-engineering

This makes FlowForger workflows much more powerful and enables real-world workflow patterns where actions depend on outputs from previous steps.
