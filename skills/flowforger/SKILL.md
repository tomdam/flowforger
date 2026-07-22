---
name: flowforger
description: FlowForger DSL expert for creating Power Automate flows. Activates when working with .ff.ts files, Power Automate, Logic Apps, or flow development.
allowed-tools: Read, Write, Edit, Bash, WebFetch
---

# FlowForger Skill

I am an expert in FlowForger, a TypeScript-based system for building Microsoft Power Automate and Azure Logic Apps workflows.

## When to Use This Skill

This skill activates when:
- Working with `.ff.ts` files (FlowForger DSL)
- Creating or modifying Power Automate flows
- Working with Logic Apps JSON
- Converting between flow formats
- Running or testing flows locally

## Quick Start

> **No `import` statement at the top of `.ff.ts` files.** The transformer resolves decorators (`@Flow`, `@HttpTrigger`, `@Action`, …) and the `FlowContext` type from its own symbol table — `.ff.ts` is not compiled by `tsc`. A line like `import { Flow, HttpTrigger, FlowContext } from "@flowforger/dsl-native"` is dead weight; omit it.

```typescript
@Flow('MyFlowName')
class MyFlowName {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('Greeting', { message: 'Hello!' });
    await ctx.http('CallAPI', { method: 'POST', url: 'https://api.example.com', body: {} });
    await ctx.response('Response', 200, { success: true });
  }

  // Constructor at BOTTOM - defines metadata, parameters, connection references
  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
      contentVersion: "1.0.0.0",
      schemaVersion: "1.0.0.0",
    };
    ctx.flow.connectionReferences = { /* required when using connectors */ };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
      // "Display Name (schemaName)": { type, defaultValue, metadata: { schemaName, description } }
      // IMPORTANT: The key here is what you pass to ctx.parameters() — must match EXACTLY
    };
    ctx.flow.childFlows = { /* when calling child workflows by name */ };
  }
}
```

## Critical Rules (Source of Truth)

**These rules apply to ALL FlowForger DSL code. Other docs reference this section.**

### 1. All action names must be unique — including across switch cases
Every action MUST have a different name. Use descriptive names: `GetPendingOrders`, `UpdateOrderStatus`, `SendConfirmationEmail`.

**This applies inside switch/case branches too.** Each case branch is a separate scope in Logic Apps, but action names must still be unique across all cases to avoid ambiguity when referencing outputs after the switch.

```typescript
// ❌ WRONG — same action name 'Set_Config' in multiple cases:
/** @action RouteByType @type switch */
switch (ctx.triggerBody()?.['type']) {
  case 'A':
    await ctx.compose('Set_Config', 'ConfigA');
    break;
  case 'B':
    await ctx.compose('Set_Config', 'ConfigB');
    break;
}

// ✅ CORRECT — unique names per case (suffix with case value or descriptor):
/** @action RouteByType @type switch */
switch (ctx.triggerBody()?.['type']) {
  /** @action Case_TypeA @type case */
  case 'A':
    await ctx.compose('Set_Config_TypeA', 'ConfigA');
    break;
  /** @action Case_TypeB @type case */
  case 'B':
    await ctx.compose('Set_Config_TypeB', 'ConfigB');
    break;
}
```

### 2. No constants outside the flow class
NEVER create constants above the class. Define parameters in the constructor, reference via `ctx.parameters('Name')`.

```typescript
// ❌ WRONG:
const SITE_URL = 'https://contoso.sharepoint.com/sites/MySite';

// ✅ CORRECT - in constructor:
"Site URL (cr_SiteUrl)": { type: 'String', defaultValue: '...', metadata: { schemaName: 'cr_SiteUrl' } }
// In run(): ctx.parameters('Site URL (cr_SiteUrl)')
```

### IMPORTANT: `ctx.parameters()` name must EXACTLY match the key in `ctx.flow.parameters`
The transformer does zero name normalization. The string you pass to `ctx.parameters('...')` must be identical to the key string in `ctx.flow.parameters`. Same rule applies to `parameters('...')` inside `ctx.eval()`.

```typescript
// Constructor:
"Site URL (cr_SiteUrl)": { type: 'String', ... }

// ❌ WRONG — shortened name:
ctx.parameters('SiteUrl')
ctx.eval(`@{parameters('cr_SiteUrl')}`)

// ✅ CORRECT — exact key match:
ctx.parameters('Site URL (cr_SiteUrl)')
ctx.eval(`@{parameters('Site URL (cr_SiteUrl)')}`)
```

### 3. JSDoc @action names variables and control flow — never named action calls
Do NOT add `@action` before `ctx.compose()`, `ctx.http()`, or connector calls - they already take the name as first parameter. Variables and control-flow statements have no name argument, so `@action` is how you name them.

**`@action` is optional, not required.** When it's missing, the transformer auto-derives a name: `Initialize_<var>`, `Set_<var>`, `Increment_<var>`, `Decrement_<var>`, `Append_<var>` for variables; `Condition` / `ForEach_<loopVar>` / `Switch` / `DoUntil` / `Case_<value>` for control flow. You should still usually provide one: the defaults are generic and collide easily (two un-annotated `if`s both become `Condition`, violating [Rule 1](#1-all-action-names-must-be-unique--including-across-switch-cases)), and a descriptive name is what you reference later with `ctx.outputs()`/`ctx.body()`.

> **Exception:** `arr.push()`, `x++`, and `x--` ignore `@action` entirely — they are ALWAYS auto-named `Append_<var>` / `Increment_<var>` / `Decrement_<var>`. To control those names, rename the variable.

```typescript
// ❌ WRONG:
/** @action Get_Data */
await ctx.compose('Get_Data', { value: 1 });

// ✅ CORRECT - no comment needed:
await ctx.compose('Get_Data', { value: 1 });

// ✅ CORRECT - @action names a variable/control-flow node (optional; auto-named otherwise, but recommended):
/** @action Initialize_counter */
let counter: number = 0;
/** @action CheckStatus @type if */
if (condition) { ... }

// ✅ ALSO VALID - no @action; auto-named "Initialize_counter" / "Condition":
let counter: number = 0;
if (condition) { ... }
```

### 4. NEVER use `return` statements
Use `ctx.terminate()` instead of `return` to exit a flow early:

```typescript
// ❌ WRONG:
if (condition) { return; }

// ✅ CORRECT:
/** @action CheckCondition @type if */
if (condition) {
  await ctx.terminate('TerminateFlow', 'Cancelled');
}
```

**`ctx.terminate()` status rules:**
- **`'Succeeded'`** and **`'Cancelled'`**: Do NOT pass a third argument. Power Automate rejects `runError` on these statuses and causes "unknown error" when publishing.
- **`'Failed'`**: Optionally pass `{ code: '...', message: '...' }` as the third argument. At least one of `code` or `message` must be non-empty.

```typescript
// ❌ WRONG — empty {} causes publish failure in Dataverse:
await ctx.terminate('Stop', 'Cancelled', {});

// ❌ WRONG — runError not allowed on Succeeded/Cancelled:
await ctx.terminate('Stop', 'Cancelled', { code: 'SKIP', message: 'Not needed' });

// ✅ CORRECT — no third arg for Cancelled/Succeeded:
await ctx.terminate('Stop', 'Cancelled');
await ctx.terminate('Done', 'Succeeded');

// ✅ CORRECT — runError only for Failed:
await ctx.terminate('FailFlow', 'Failed', { code: 'ERR001', message: 'Validation failed' });
```

### 5. NEVER use `@{...}` wrapping for array/object values

In Power Automate, `@expression` preserves the original return type (array, object, number, etc.), while `@{expression}` **always converts to string**. This applies to both `ctx.braced()` AND `ctx.eval('@{...}')`.

**This breaks foreach loops, array variable assignments, and any action that expects an array or object.**

```typescript
// ❌ WRONG — ctx.braced() converts the array to a string:
await ctx.compose('MergedItems', ctx.braced(ctx.union(array1, array2)));
// Produces: "@{union(...)}" → STRING

// ❌ WRONG — ctx.eval('@{...}') also causes string coercion:
myArray = ctx.eval(`@{union(variables('myArray'), createArray(items('MyLoop')))}`);
// Produces SetVariable value: "@{union(...)}" → STRING, breaks array variable

// ✅ CORRECT — pass the expression directly to preserve the array type:
await ctx.compose('MergedItems', ctx.union(array1, array2));
// Produces: "@union(...)" → ARRAY

// ✅ CORRECT — ctx.eval() WITHOUT braces preserves the type:
myArray = ctx.eval(`@union(variables('myArray'), createArray(items('MyLoop')))`);
// Produces SetVariable value: "@union(...)" → ARRAY
```

**The rule:** Never wrap expressions in `@{...}` when the result must remain an array, object, or number. This means:
- Use `ctx.union(a, b)` or `ctx.eval('@union(...)')` — NOT `ctx.eval('@{union(...)}')`
- Use `ctx.braced()` ONLY when you explicitly want string output (e.g., building a display string, URI parts)
- Never use `@{...}` for values that will be iterated over, assigned to array variables, parsed as JSON, or used as arrays/objects

```typescript
// ✅ @{...} is fine here — building a display string:
await ctx.compose('EmailList', ctx.braced(ctx.join(ctx.variables('emails'), ';')));

// ✅ @{...} is fine here — building a URI:
await ctx.connectors.sharepoint.HttpRequest('Call', {
  'parameters/uri': ctx.eval(`_api/web/lists(guid'@{triggerBody()?['ListId']}')/items`)
}, 'shared_sharepointonline');

// ❌ @{...} is WRONG for array values:
await ctx.compose('AllItems', ctx.braced(ctx.union(arr1, arr2)));
myArray = ctx.eval(`@{union(variables('myArray'), createArray(outputs('Item')))}`);

// ✅ CORRECT — no @{...}, type is preserved:
await ctx.compose('AllItems', ctx.union(arr1, arr2));
myArray = ctx.eval(`@union(variables('myArray'), createArray(outputs('Item')))`);
```

## Key Decorators

| Decorator | Purpose |
|-----------|---------|
| `@Flow('name')` | Marks class as a flow |
| `@HttpTrigger()` | HTTP/webhook trigger |
| `@ManualTrigger()` | Button/PowerApp trigger (every input under `schema.properties` must include `"x-ms-dynamically-added": true` or the maker-portal designer hides it — see [dsl-syntax.md](dsl-syntax.md#manual-trigger)) |
| `@RecurrenceTrigger({...})` | Scheduled trigger |
| `@ConnectorTrigger()` | Connector-based trigger (e.g., SharePoint "when item created") |
| `@Action()` | Flow action method (always named `run`) |

## FlowContext Methods

| Method | Purpose |
|--------|---------|
| `await ctx.compose('Name', value)` | Create data |
| `await ctx.http('Name', {...})` | HTTP request |
| `await ctx.response('Name', status, body)` | HTTP response (for PowerApp/VirtualAgent responses, pass `schema` as the 5th arg and `'PowerApp'`/`'VirtualAgent'` as the 6th — every property under `schema.properties` must include `"x-ms-dynamically-added": true` or the maker-portal designer hides the output; see [dsl-syntax.md](dsl-syntax.md#response)) |
| `await ctx.terminate('Name', status)` | End flow (never use `return`; only pass `{ code, message }` for `'Failed'`) |
| `await ctx.connectorWebhook('Name', {...})` | Webhook connector action (e.g., Approvals) |
| `ctx.triggerBody()` | Get trigger body |
| `ctx.body('ActionName')` | Get action body (HTTP/connectors) |
| `ctx.outputs('ActionName')` | Get action outputs (Compose actions) |
| `ctx.variables('varName')` | Get variable value |
| `ctx.parameters('paramName')` | Get flow parameter (name must exactly match key in `ctx.flow.parameters`) |
| `ctx.eval('@expression')` | Evaluate Power Automate expression (use `@expr` for type-preserving, `@{expr}` only for strings) |
| `ctx.workflow()` | Get workflow metadata |
| `await ctx.callWorkflow('Name', ref, body)` | Call a child workflow (ref = child flow name or GUID) |

## When to Use ctx.body() vs ctx.outputs()

| Action Type | Method | Why |
|-------------|--------|-----|
| **Compose** | `ctx.outputs('Name')` | Compose puts data directly in outputs |
| **HTTP** | `ctx.body('Name')` | HTTP response is in `outputs.body` |
| **Connectors** | `ctx.body('Name')` | Connector responses are in `outputs.body` |
| **Child Workflow** | `ctx.body('Name')` | Child flow response is in `outputs.body` |

```typescript
await ctx.compose('Payload', { name: 'test' });
ctx.outputs('Payload')             // ✅ for Compose

await ctx.http('Fetch', { method: 'GET', url: '...' });
ctx.body('Fetch')?.['name']        // ✅ for HTTP

await ctx.connectors.sharepoint.GetItems('Items', {...}, 'shared_sharepointonline');
ctx.body('Items')?.['value']       // ✅ for Connectors

await ctx.callWorkflow('RunChild', 'MyChildFlow', { text: 'hello' });
ctx.body('RunChild')               // ✅ for Child Workflows
```

### 6. Try/Catch MUST have a Finally scope (or explicit multi-dependency @runAfter)

**This is the most common cause of broken flows.** The DSL transformer auto-chains each action to the previous one with `runAfter: { "PreviousAction": ["Succeeded"] }`. In a try/catch pattern, the "previous action" for anything after the catch is the CatchBlock — but CatchBlock only runs when TryBlock **fails**. If TryBlock succeeds, CatchBlock is skipped, and **every action after it is also skipped**, breaking the flow in half.

```typescript
// ❌ BROKEN — if TryBlock succeeds, CatchBlock is skipped,
// and Response is ALSO skipped (it auto-depends on CatchBlock: Succeeded)
/** @action TryBlock @type scope */
{
  await ctx.http('RiskyCall', { method: 'GET', url: '...' });
}

/** @action CatchBlock @type scope @runAfter TryBlock: Failed */
{
  await ctx.compose('Error', { failed: true });
}

await ctx.response('Response', 200, { done: true }); // ← NEVER RUNS on success path!
```

**Fix A (recommended): Always add a Finally scope**

```typescript
// ✅ CORRECT — FinallyBlock runs on ALL outcomes, so actions after it are safe
/** @action TryBlock @type scope */
{
  await ctx.http('RiskyCall', { method: 'GET', url: '...' });
}

/** @action CatchBlock @type scope @runAfter TryBlock: Failed */
{
  await ctx.compose('Error', { failed: true });
}

/** @action FinallyBlock @type scope @runAfter TryBlock: Succeeded, Failed, Skipped */
{
  await ctx.compose('Cleanup', { done: true });
}

// Safe — FinallyBlock always runs, so auto-chaining works
await ctx.response('Response', 200, { done: true });
```

**Fix B: Explicit multi-dependency @runAfter on the next action**

```typescript
// ✅ CORRECT — explicit @runAfter covers both paths
/** @action TryBlock @type scope */
{
  await ctx.http('RiskyCall', { method: 'GET', url: '...' });
}

/** @action CatchBlock @type scope @runAfter TryBlock: Failed */
{
  await ctx.compose('Error', { failed: true });
}

/** @action SendResponse @runAfter TryBlock: Succeeded @runAfter CatchBlock: Succeeded */
await ctx.response('Response', 200, { done: true });
```

**The rule applies to ALL actions with conditional @runAfter**, not just try/catch. Any time an action uses `@runAfter X: Failed` (or any non-default status), actions after it will be skipped on the success path unless you add a finally scope or explicit multi-dependency @runAfter.

### 7. Use `&&`/`||` operators instead of `ctx.and()`/`ctx.or()` in if conditions

The transformer correctly handles JavaScript `&&` and `||` operators, converting them to Power Automate `and()` and `or()` functions. However, `ctx.and()` and `ctx.or()` as **top-level if-condition expressions** can fail to transform, producing raw TypeScript code in the compiled output.

```typescript
// ❌ WRONG — ctx.and() as if-condition may produce broken output:
/** @action ValidateOrder @type if */
if (ctx.and(
  ctx.not(ctx.empty(order?.['productId'])),
  ctx.greater(order?.['quantity'], 0)
)) {
  // ...
}
// Compiled: "@ctx.and(\n  ctx.not(..." ← raw TypeScript dumped, BROKEN

// ✅ CORRECT — use && operator instead:
/** @action ValidateOrder @type if */
if (ctx.not(ctx.empty(order?.['productId'])) && ctx.greater(order?.['quantity'], 0)) {
  // ...
}
// Compiled: @and(not(empty(items('...')?['productId'])), greater(items('...')?['quantity'], 0))
```

**The rule:** Always use `&&` for AND conditions and `||` for OR conditions in `@type if` annotations. Individual ctx methods like `ctx.not()`, `ctx.empty()`, `ctx.greater()`, `ctx.equals()`, etc. work fine as arguments — it's only `ctx.and()`/`ctx.or()` as the **outermost expression** in an if condition that break.

```typescript
// ✅ These all work correctly:
if (ctx.equals(value, 'test'))                          // single condition
if (ctx.not(ctx.empty(value)))                          // nested ctx calls
if (ctx.greater(ctx.mul(a, b), 1000))                   // nested math
if (ctx.not(ctx.empty(x)) && ctx.greater(y, 0))         // && operator
if (condition1 || condition2)                            // || operator
if (value === 'test')                                    // === operator

// ❌ These may produce broken output:
if (ctx.and(condition1, condition2))                     // ctx.and() as top-level
if (ctx.or(condition1, condition2))                      // ctx.or() as top-level
```

### 8. Use `.push()` to append to array variables — NEVER spread/reassignment

Power Automate appends to an array variable via the **AppendToArrayVariable** action. In the FlowForger DSL, this maps to `arrayName.push(value)`. The transformer **only** recognizes the `.push()` pattern — array spread-reassignment (`arr = [...arr, item]`) is **not transformed** and will emit raw TypeScript into the flow, producing a broken action.

```typescript
// Declare the array variable first:
/** @action Initialize_userEmails */
let userEmails: string[] = [];

// ❌ WRONG — spread-reassignment is NOT supported by the transformer.
// This emits literal strings like "...userEmails" into the SetVariable value:
/** @action Append_email */
userEmails = [...userEmails, user?.['Email']];

// ❌ WRONG — even worse, a quoted spread is a plain string, not a spread at all:
userEmails = ['...userEmails', user?.['Email']];

// ❌ WRONG — plain reassignment replaces the whole array (SetVariable, not Append):
userEmails = userEmails.concat([user?.['Email']]);

// ✅ CORRECT — .push() maps to AppendToArrayVariable:
/** @action Append_email */
userEmails.push(user?.['Email']);
```

**The rule:** To add an item to an array variable, call `.push(item)` on the variable. Use a dedicated JSDoc `@action` name on the line. Never rebuild the array via spread, concat, or any assignment form — the transformer does not understand those patterns for array append.

**For appending into a loop-scoped accumulator** (merging arrays inside a foreach), use `ctx.union()` with `.push()` one item at a time, or accumulate into a compose and use `ctx.union()` once after the loop:

```typescript
/** @action Initialize_userEmails */
let userEmails: string[] = [];

/** @action ForEachUser @type foreach */
for (const user of ctx.body('GetUsers')?.['value'] ?? []) {
  /** @action Append_email */
  userEmails.push(ctx.items('ForEachUser')?.['Email']);
}
```

### 9. Action descriptions (comments above an action) MUST be ≤ 256 characters

Any **plain comment** (`//` or `/* */`) or `@description` text placed above an action is captured by the transformer as that action's `description` field. The emitter copies it verbatim into the Logic Apps JSON (`"description": "..."`), and Dataverse enforces a **256-character limit** on this field. A longer description does NOT fail at compile time — it fails later, when **pushing/publishing to Power Automate (Dataverse)**, with an opaque error. AI agents authoring `.ff.ts` files frequently write long explanatory comments above actions, which silently overflow this limit.

```typescript
// ❌ WRONG — this 300+ char explanatory comment becomes the action description
// and exceeds Dataverse's 256-char limit, breaking the push/publish:
// This compose builds the full notification payload that will later be sent to the
// approver. It merges the order header, the line items, the requester's display name
// and email, plus the computed total so the approval card renders everything inline.
await ctx.compose('BuildPayload', { order: ctx.triggerBody() });

// ✅ CORRECT — keep the description short (≤ 256 chars):
// Build the approval notification payload from the order trigger body.
await ctx.compose('BuildPayload', { order: ctx.triggerBody() });
```

**What counts toward the 256 characters:**
- Only the **descriptive prose** — plain comments and `@description` text.
- Structural JSDoc tags are **stripped** and do NOT count: `@action`, `@type`, `@runAfter`, `@limit`, `@retryPolicy`, `@metadata`, etc. So `/** @action Foo @type if */` contributes nothing to the description.
- A plain comment placed **above** a `/** @action … */` JSDoc block is also folded into the description — so it counts too.

```typescript
// ❌ WRONG — the plain comment above the JSDoc is the description; if it's long it overflows:
// Long multi-sentence explanation of why we loop over every pending order and re-check
// its status against the upstream system before deciding whether to send a reminder...
/** @action ForEachOrder @type foreach */
for (const order of ctx.body('GetOrders')?.['value'] ?? []) { ... }

// ✅ CORRECT — short description, detail (if any) lives outside the action comment:
// Loop pending orders and re-check status.
/** @action ForEachOrder @type foreach */
for (const order of ctx.body('GetOrders')?.['value'] ?? []) { ... }
```

**The rule:** Keep every action/trigger description (and any comment that becomes one) at **256 characters or fewer**. If you need to explain complex logic, put the long explanation somewhere that is NOT captured as a description — e.g., a comment *inside* the action body, or split the work across multiple well-named actions. Prefer concise, single-sentence descriptions. This same 256-char limit applies to trigger descriptions and the flow-level description.

## Control Flow Summary

| Pattern | JSDoc Annotation | JS Syntax |
|---------|-----------------|-----------|
| If/Else | `@action Name @type if` | `if (...) { } else { }` |
| Switch | `@action Name @type switch` | `switch (...) { case: ... }` |
| For Each | `@action Name @type foreach` | `for (const x of ...) { }` |
| Do-Until | `@action Name @type until` | `do { } while (...)` |
| Scope | `@action Name @type scope` | `{ ... }` (bare block) |
| Try/Catch | Scope + `@runAfter` + **Finally scope** | See [Critical Rule 6](#6-trycatch-must-have-a-finally-scope-or-explicit-multi-dependency-runafter) |

See [DSL Syntax Reference](dsl-syntax.md) for detailed syntax.

## Available Connectors

| Connector | Access | Connection Reference |
|-----------|--------|---------------------|
| SharePoint | `ctx.connectors.sharepoint` | `shared_sharepointonline` |
| Dataverse | `ctx.connectors.dataverse` | `shared_commondataserviceforapps` |
| Office 365 | `ctx.connectors.office365` | `shared_office365` |
| Excel Online | `ctx.connectors.excelonline` | `shared_excelonlinebusiness` |
| Word Online | `ctx.connectors.wordonline` | `shared_wordonlinebusiness` |
| Approvals | `ctx.connectors.approvals` | `shared_approvals` |
| Any other | `ctx.connectors['name']` | Custom reference name |

See [Connectors Reference](connectors.md) for all operations and parameters.

## Documentation

- [DSL Syntax Reference](dsl-syntax.md) - Triggers, actions, variables, control flow, expressions
- [Connectors Reference](connectors.md) - All connector operations and parameters
- [Examples](examples.md) - Common flow patterns
- [Formal Grammar & Conformance](https://github.com/tomdam/flowforger/blob/main/docs/grammar/README.md) - EBNF for the recognized subset and JSDoc tags, the 14 conformance rules (spec-style restatement of this file), and a fully-annotated [canonical example](https://github.com/tomdam/flowforger/blob/main/docs/grammar/canonical-example.ff.ts)

## MCP Integration

If connected to FlowForger MCP server, I can use these tools:
- `transformDSL` - Convert DSL to FlowIR
- `validateFlow` - Validate flow definitions
- `compileToLogicApps` - Generate Logic Apps JSON
- `runFlow` - Execute flows locally
- `reverseEngineer` - Convert Logic Apps to DSL

## Slash Commands

- `/flowforger-create <description>` - Create a new flow
- `/flowforger-run <file>` - Run a flow locally
- `/flowforger-convert <file>` - Convert between formats
- `/flowforger-validate <file>` - Validate a flow
- `/flowforger-session <id>` - Connect to browser session
