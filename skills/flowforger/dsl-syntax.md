# FlowForger DSL Syntax Reference

> **Critical Rules**: See [SKILL.md](SKILL.md#critical-rules-source-of-truth) for the 8 mandatory rules (unique names, no constants, @action only for variables/control flow, no return statements, no `@{...}` for arrays, try/catch finally, use `&&`/`||` not `ctx.and()`/`ctx.or()`, use `.push()` not spread for array append).

## Basic Structure

Every flow has a trigger, a single `run()` method, and a constructor at the bottom:

```typescript
@Flow('MyFlowName')
class MyFlowName {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    // All flow logic here
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
      contentVersion: "1.0.0.0",
      schemaVersion: "1.0.0.0",
    };
    ctx.flow.connectionReferences = { /* when using connectors */ };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
    };
  }
}
```

## Triggers

### HTTP Trigger

```typescript
@HttpTrigger({ method: 'POST' })
trigger() {}

// With schema
@HttpTrigger({ method: 'POST' })
trigger() {
  return { schema: { type: 'object', properties: { name: { type: 'string' } } } };
}
```

### Manual Trigger

```typescript
@ManualTrigger()
trigger(ctx: FlowContext) {
  return { schema: { type: 'object', properties: {}, required: [] } };
}
```

**Inputs (required for maker portal visibility):** every property under `schema.properties` MUST include `"x-ms-dynamically-added": true`. Without it the new Power Automate maker-portal designer silently hides the input from the trigger UI (the flow still runs, but makers can't see/edit the parameter). Also include `"x-ms-content-hint"` (e.g. `"TEXT"`, `"EMAIL"`, `"FILE"`) and a `title` + `description` so the designer renders a proper label.

```typescript
@ManualTrigger()
trigger(ctx: FlowContext) {
  return {
    schema: {
      type: 'object',
      properties: {
        text: {
          title: 'Object Id',
          type: 'string',
          description: 'Object Id',
          'x-ms-dynamically-added': true,
          'x-ms-content-hint': 'TEXT',
        },
      },
      required: ['text'],
    },
  };
}
```

### Recurrence Trigger

```typescript
@RecurrenceTrigger({ frequency: 'Day', interval: 1 })
trigger() {}

@RecurrenceTrigger({ frequency: 'Hour', interval: 4, startTime: '2024-01-01T09:00:00Z' })
trigger() {}
```

### Connector Trigger

```typescript
@ConnectorTrigger()
trigger(ctx: FlowContext) {
  return {
    connector: 'sharepoint',
    operation: 'GetOnNewItems',
    params: {
      dataset: 'https://contoso.sharepoint.com/sites/MySite',
      table: '{list-guid}'
    },
    connectionReferenceName: 'shared_sharepointonline',
    splitOn: "@triggerOutputs()?['body/value']",
    recurrence: { interval: 15, frequency: 'Minute' }
  };
}
```

## Actions

All actions are `await`ed with the action name as first parameter.

### Compose

```typescript
await ctx.compose('ActionName', { key: 'value' });
await ctx.compose('SimpleValue', 'text value');
await ctx.compose('FromTrigger', ctx.triggerBody()?.['data']);
```

### HTTP Request

```typescript
await ctx.http('GetData', { method: 'GET', url: 'https://api.example.com/data' });

await ctx.http('PostData', {
  method: 'POST',
  url: 'https://api.example.com/items',
  body: { name: 'Item' },
  headers: { 'Content-Type': 'application/json' }
});
```

### Response

```typescript
await ctx.response('Response', 200, { success: true });
await ctx.response('Response', 200, ctx.body('ActionName'));
```

**Response body schema (required for PowerApp / maker-portal visibility):** when the response is consumed by Power Apps or surfaced in the maker-portal designer (e.g. "Respond to a PowerApp or flow"), pass a `schema` as the 5th argument and `'PowerApp'` (or `'VirtualAgent'`) as the 6th. The 4th argument is `headers` — pass `undefined` if you don't have any. Every property under `schema.properties` MUST include `"x-ms-dynamically-added": true`, otherwise the maker-portal designer silently hides the output and PowerApps can't bind to it.

```typescript
await ctx.response('Response', 200, {
  IsAdmin: ctx.outputs('IsAdmin'),
  Kpi1: ctx.outputs('Kpi1Value'),  
}, undefined, {
  type: 'object',
  properties: {
    IsAdmin: { type: 'boolean', title: 'IsAdmin', 'x-ms-dynamically-added': true },
    Kpi1:    { type: 'integer', title: 'Kpi1',    'x-ms-dynamically-added': true },    
  },
}, 'PowerApp');
```

### Terminate

Use instead of `return` to end a flow early. Parameters: action name, status (`'Succeeded'`/`'Failed'`/`'Cancelled'`), and optionally error details (only for `'Failed'`).

**Important:** Only pass the third argument (`{ code, message }`) when status is `'Failed'`. Power Automate rejects `runError` on `Succeeded`/`Cancelled` and causes publish failures in Dataverse.

```typescript
// Succeeded / Cancelled — no third argument:
await ctx.terminate('TerminateSuccess', 'Succeeded');
await ctx.terminate('SkipProcessing', 'Cancelled');

// Failed — optional error details:
await ctx.terminate('TerminateOnError', 'Failed', { code: 'ERR', message: 'Validation failed' });

// ❌ WRONG — runError on non-Failed status breaks Dataverse publishing:
await ctx.terminate('Stop', 'Cancelled', {});
await ctx.terminate('Stop', 'Cancelled', { code: 'SKIP', message: 'Not needed' });
```

### Connector Webhook

For long-running connector actions (e.g., Approvals) that use webhook callbacks:

```typescript
await ctx.connectorWebhook('WaitForApproval', {
  connector: 'approvals',
  operation: 'StartAndWaitForAnApproval',
  params: {
    approvalType: 'Basic',
    title: 'Please approve',
    assignedTo: 'approver@example.com'
  },
  connectionReferenceName: 'shared_approvals'
});
```

### Child Workflow Call

Call a child workflow (another Power Automate flow). The second argument can be a friendly name (defined in `ctx.flow.childFlows` in the constructor) or a direct GUID.

```typescript
// By name (preferred — requires childFlows in constructor)
await ctx.callWorkflow('RunChildFlow', 'GenerateDocument', {
  text: ctx.triggerOutputs()?.['body/recordId'],
  text_1: ctx.variables('folderPath'),
});

// By GUID (works without childFlows declaration)
await ctx.callWorkflow('RunChildFlow', 'fa05dee0-12d5-f011-8544-7c1e523655f2', {
  text: ctx.triggerOutputs()?.['body/recordId'],
});
```

Child flow outputs are accessed via `ctx.body('ActionName')`.

## Variables

Declare as local TypeScript variables. The JSDoc `@action` comment names the resulting
InitializeVariable/SetVariable action — it is **optional** (the transformer auto-names a
declaration `Initialize_<varName>`, an assignment `Set_<varName>`, etc.), but **recommended**
so the names are descriptive and unique. (`arr.push()`, `x++`, and `x--` ignore `@action` —
they are always auto-named `Append_`/`Increment_`/`Decrement_<varName>`.)

```typescript
/** @action Initialize_counter */
let counter: number = 0;

/** @action Initialize_items */
let items: any[] = [];

/** @action Initialize_name */
let name: string = 'default';

// Update variable (SetVariable)
/** @action Set_counter */
counter = counter + 1;

// Read variable
await ctx.compose('Result', { count: ctx.variables('counter') });
```

### Appending to Array Variables

**Use `.push(value)` — NEVER spread or reassignment.** This maps to the Power Automate `AppendToArrayVariable` action. See [Critical Rule 8](SKILL.md#8-use-push-to-append-to-array-variables--never-spreadreassignment).

```typescript
/** @action Initialize_userEmails */
let userEmails: string[] = [];

// ✅ CORRECT — .push() → AppendToArrayVariable:
/** @action Append_email */
userEmails.push(user?.['Email']);

// ❌ WRONG — spread-reassignment is not transformed, emits raw TypeScript:
userEmails = [...userEmails, user?.['Email']];

// ❌ WRONG — quoted spread is just a literal string:
userEmails = ['...userEmails', user?.['Email']];

// ❌ WRONG — replaces the whole array (SetVariable), does NOT append:
userEmails = userEmails.concat([user?.['Email']]);
```

## Control Flow

Use native JavaScript control flow with JSDoc annotations.

### If/Else

```typescript
/** @action Check_status @type if */
if (ctx.triggerBody()?.['status'] === 'active') {
  await ctx.compose('Active', { isActive: true });
} else {
  await ctx.compose('Inactive', { isActive: false });
}
```

**Compound conditions:** Use `&&` and `||` operators (NOT `ctx.and()`/`ctx.or()`). See [Critical Rule 7](SKILL.md#7-use--operators-instead-of-ctxandctxor-in-if-conditions).

```typescript
// ✅ CORRECT — use && operator for compound conditions:
/** @action ValidateInput @type if */
if (ctx.not(ctx.empty(item?.['name'])) && ctx.greater(item?.['quantity'], 0)) {
  // ...
}

// ❌ WRONG — ctx.and() may produce broken output:
if (ctx.and(ctx.not(ctx.empty(item?.['name'])), ctx.greater(item?.['quantity'], 0))) {
  // ...
}
```

**Condition emit format (advanced — usually omit):** The emitter has three modes for how the condition is serialized to Logic Apps JSON. The default works for almost everything; the two opt-outs exist only for round-trip parity with hand-edited source JSON.

| Annotation | Emits | When to use |
|---|---|---|
| *(none — default)* | `"expression": { "and": [ { "contains": [...] } ] }` | **Default for all new flows.** The maker-portal designer can only render the visual condition rows when the top-level is `and`/`or` — a single comparison gets auto-wrapped in `and: [...]` so the condition is editable in the UI. |
| `@conditionFormat string` | `"expression": "@contains(...)"` | Source JSON was a raw `@expression` string and you want to preserve it byte-for-byte. The flow still runs, but the condition shows as code-only in the designer. |
| `@conditionFormat object` | `"expression": { "contains": [...] }` (no `and` wrapper) | Source JSON had a bare comparison/`not` object without the `and` wrapper and you need exact parity. Rare. |

```typescript
// ✅ DEFAULT — omit the annotation, get designer-visible output:
/** @action Check_filename @type if */
if (ctx.contains(ctx.triggerOutputs()?.['body/{Name}'], iban)) { ... }

// Opt-outs (only if preserving an existing source shape matters):
/** @action Check_filename @type if @conditionFormat string */
/** @action Check_filename @type if @conditionFormat object */
```

The parser drops single-operand `and`/`or` when reverse-engineering Logic Apps JSON back to DSL, so generated flows come out clean (`if (ctx.contains(...))`, not `if (ctx.and(ctx.contains(...)))`); the default emitter re-wraps on the way back.

### Switch

**Important:** Action names inside each case must be unique across ALL cases — do not reuse the same action name in different branches. Suffix with the case value or a descriptor to differentiate.

```typescript
/** @action Route_by_type @type switch */
switch (ctx.triggerBody()?.['type']) {
  /** @action Case_TypeA @type case */
  case 'A':
    await ctx.compose('HandleA', 'Type A');
    break;
  /** @action Case_TypeB @type case */
  case 'B':
    await ctx.compose('HandleB', 'Type B');
    break;
  /** @action Case_Default @type case */
  default:
    await ctx.compose('HandleDefault', 'Unknown type');
}
```

```typescript
// ❌ WRONG — same action name in every case:
switch (ctx.body('GetRecord')?.['type']) {
  case 1: await ctx.compose('Config_Key', 'value1'); break;
  case 2: await ctx.compose('Config_Key', 'value2'); break;
  case 3: await ctx.compose('Config_Key', 'value3'); break;
}

// ✅ CORRECT — unique action names per case:
switch (ctx.body('GetRecord')?.['type']) {
  /** @action Case_Type1 @type case */
  case 1: await ctx.compose('Config_Key_Type1', 'value1'); break;
  /** @action Case_Type2 @type case */
  case 2: await ctx.compose('Config_Key_Type2', 'value2'); break;
  /** @action Case_Type3 @type case */
  case 3: await ctx.compose('Config_Key_Type3', 'value3'); break;
}
```

### For Each Loop

```typescript
/** @action Process_items @type foreach */
for (const item of ctx.body('GetItems')?.['value'] ?? []) {
  await ctx.http('ProcessItem', { method: 'POST', url: '...', body: item });
}
```

Inside loops, action names don't need to be unique across iterations - the same action runs for each item.

#### Parallel iterations (`@runtimeConfig`)

By default, foreach iterations run **sequentially**. When iterations are independent (no shared variable mutation, no order dependency), enable parallel execution with `@runtimeConfig {"concurrency":{"repetitions":N}}` — N can go up to 50. This is the single biggest performance lever for loops that make HTTP/connector calls per iteration.

```typescript
// Sequential — 4 users × ~500ms each = ~2s
/** @action GrantPermissions @type foreach */
for (const email of ctx.outputs('UserEmails') ?? []) {
  await ctx.connectors.sharepoint.HttpRequest('EnsureUser', { /*...*/ });
  await ctx.connectors.sharepoint.HttpRequest('GrantUserEdit', { /*...*/ });
}

// Parallel — same 4 users now run concurrently, ~500ms total
/** @action GrantPermissions @type foreach @runtimeConfig {"concurrency":{"repetitions":20}} */
for (const email of ctx.outputs('UserEmails') ?? []) {
  await ctx.connectors.sharepoint.HttpRequest('EnsureUser', { /*...*/ });
  await ctx.connectors.sharepoint.HttpRequest('GrantUserEdit', { /*...*/ });
}
```

Actions **inside** the loop still run serially per iteration (correct — `GrantUserEdit` reads `EnsureUser`'s output). Only the iterations themselves fan out.

**Do NOT use parallel iterations when:** the body appends to an array variable via `.push()`, increments a counter, or otherwise mutates shared state — Power Automate's `AppendToArrayVariable` / `SetVariable` are not safe under concurrency. The FlowForger optimizer warns about this pattern (see `packages/dsl-native/src/optimizer/patterns/parallelism-analyzer.ts`).

### Do-Until Loop

```typescript
/** @action PollUntilComplete @type until */
do {
  await ctx.http('CheckStatus', { method: 'GET', url: '...' });
} while (ctx.body('CheckStatus')?.['status'] !== 'complete');
```

### Scope (Code Block)

`@type scope` is **required** for a bare block — without it the block is flattened and its
statements are inlined (a Scope node is created only when the `@type scope` tag is present).
This is the one control construct where `@type` is mandatory; for `if`/`foreach`/`switch`/`until`
it is optional (those are recognized structurally) though still recommended for clarity.

```typescript
/** @action MainProcessing @type scope */
{
  await ctx.http('Step1', { method: 'GET', url: '...' });
  await ctx.compose('Step2', ctx.body('Step1'));
}
```

### Try/Catch Pattern (Scopes + RunAfter)

> **WARNING:** See [Critical Rule 6](SKILL.md#6-trycatch-must-have-a-finally-scope-or-explicit-multi-dependency-runafter). A try/catch without a Finally scope **breaks the flow** — all actions after the catch block will be skipped on the success path.

**Always use a Finally scope (recommended):**

```typescript
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

// Actions after FinallyBlock are safe — it always runs
await ctx.response('Response', 200, { result: 'done' });
```

**Alternative: explicit multi-dependency @runAfter on the next action:**

```typescript
/** @action TryBlock @type scope */
{
  await ctx.http('RiskyCall', { method: 'GET', url: '...' });
}

/** @action CatchBlock @type scope @runAfter TryBlock: Failed */
{
  await ctx.compose('Error', { failed: true });
}

// Multiple @runAfter covers both success and failure paths
/** @action SendResponse @runAfter TryBlock: Succeeded @runAfter CatchBlock: Succeeded */
await ctx.response('Response', 200, { done: true });
```

## Referencing Data

### Trigger Data

```typescript
ctx.triggerBody()                       // Trigger request body
ctx.triggerBody()?.['property']         // Property from trigger body
ctx.triggerOutputs()                    // Full trigger outputs
```

### Action Outputs

> See [SKILL.md](SKILL.md#when-to-use-ctxbody-vs-ctxoutputs) for the body() vs outputs() reference table.

```typescript
// Compose → ctx.outputs()
ctx.outputs('ComposeName')?.['property']

// HTTP/Connectors → ctx.body()
ctx.body('HttpAction')?.['property']
ctx.body('ConnectorAction')?.['value']

// Full outputs path (works for any action type)
ctx.outputs('ActionName')?.['body/property']
```

### Variables and Parameters

```typescript
ctx.variables('varName')                // Get variable value
ctx.parameters('ParameterName')         // Get flow parameter — name MUST exactly match key in ctx.flow.parameters
```

**Parameter name matching rule:** The string passed to `ctx.parameters('...')` or `parameters('...')` inside `ctx.eval()` must be **identical** to the key in `ctx.flow.parameters`. No normalization or shortening is applied.

```typescript
// If constructor defines: "Site URL (cr_SiteUrl)": { type: 'String', ... }
ctx.parameters('Site URL (cr_SiteUrl)')      // ✅ exact match
ctx.parameters('SiteUrl')                     // ❌ won't resolve
ctx.parameters('cr_SiteUrl')                  // ❌ won't resolve
```

### Workflow Info

```typescript
ctx.workflow()?.['name']                // Flow name
ctx.workflow()?.['run']?.['name']       // Run ID
ctx.workflow()?.['tags']?.['environmentName']
```

## Expressions with ctx.eval()

For Power Automate expressions that cannot be expressed via ctx methods, use `ctx.eval()`.

**Critical:** `ctx.eval()` outputs the expression string as-is. Use `@expression` (no braces) when the result must preserve its type (array, object, number). Use `@{expression}` only for string interpolation. See [Critical Rule 5](SKILL.md#5-never-use--wrapping-for-arrayobject-values).

```typescript
// ✅ String interpolation — @{...} is correct here:
await ctx.compose('Result', ctx.eval(`@{concat('Hello ', triggerBody()?['name'])}`));

// ✅ URI construction — @{...} is fine for string parts:
await ctx.connectors.sharepoint.HttpRequest('Call', {
  dataset: siteUrl,
  'parameters/uri': ctx.eval(`_api/web/lists(guid'@{triggerBody()?['ListId']}')/items`)
}, 'shared_sharepointonline');

// ✅ Array variable append — @expr (no braces) preserves the array:
myArray = ctx.eval(`@union(variables('myArray'), createArray(items('MyLoop')))`);

// ❌ WRONG — @{...} converts the array to a string:
myArray = ctx.eval(`@{union(variables('myArray'), createArray(items('MyLoop')))}`);
```

## Expression Format: `@expression` vs `@{expression}` (Critical)

Power Automate has two expression formats with **different type behavior**:

| Format | Syntax | Return Type | Use When |
|--------|--------|-------------|----------|
| `@expression` | `@union(a, b)` | **Preserves original type** (array, object, number) | Compose values that are arrays/objects, foreach sources, variable assignments |
| `@{expression}` | `@{union(a, b)}` | **Always string** | String interpolation, building display text, URI parts |

In FlowForger DSL:
- **Direct ctx method** → generates `@expression` (type-preserving): `ctx.union(a, b)`
- **`ctx.eval('@expr')`** → outputs as-is (type-preserving if no braces): `ctx.eval('@union(a, b)')`
- **`ctx.eval('@{expr}')`** → outputs as-is (string coercion from `@{...}`): `ctx.eval('@{concat(...)}')`
- **`ctx.braced(expr)`** → generates `@{expression}` (string coercion): `ctx.braced(ctx.union(a, b))`

### Common mistakes: `@{...}` on array/object values

```typescript
// ❌ WRONG — foreach will fail with "result is of type 'String'":
await ctx.compose('Items', ctx.braced(ctx.union(arr1, arr2)));
myArray = ctx.eval(`@{union(variables('myArray'), createArray(outputs('Item')))}`);

// ✅ CORRECT — array type preserved:
await ctx.compose('Items', ctx.union(arr1, arr2));
myArray = ctx.eval(`@union(variables('myArray'), createArray(outputs('Item')))`);
```

**Rule of thumb:** Only use `@{...}` (whether via `ctx.braced()` or `ctx.eval()`) when the result is consumed as a string. For values fed into foreach loops, array variable assignments, conditions, or further array operations, use `@expression` without braces.

## RunAfter (Action Dependencies)

Control execution order and error handling with `@runAfter`:

```typescript
/** @action Step1 @type scope */
{ await ctx.compose('First', 'data'); }

/** @action Step2 @type scope @runAfter Step1: Succeeded */
{ await ctx.compose('Second', 'data'); }

/** @action ErrorHandler @type scope @runAfter Step1: Failed */
{ await ctx.compose('HandleError', 'error'); }

/** @action Always @type scope @runAfter Step1: Succeeded, Failed, Skipped */
{ await ctx.compose('AlwaysRun', 'cleanup'); }
```

### Multiple @runAfter Dependencies

An action can depend on multiple predecessors. This is essential after branching patterns (try/catch) where you need to cover both paths:

```typescript
/** @action Continue @runAfter TryBlock: Succeeded @runAfter CatchBlock: Succeeded */
await ctx.compose('Next', 'continues on both paths');
```

Quoted action names are supported for names containing special characters:

```typescript
/** @action Next @runAfter "Step:One": Succeeded @runAfter "Step:Two": Failed */
```

### Parallel branches (fan-out via @runAfter)

When the DSL transformer sees a sequence of `await` calls, it auto-chains them: each action's `runAfter` defaults to the previous action. This produces a serial pipeline. When several actions are **independent** (only depend on the same upstream predecessor), make them parallel branches by giving each an explicit `@runAfter` pointing at that shared predecessor — they then dispatch concurrently instead of waiting for each other.

```typescript
// ❌ Serial — three queries chain off each other (~3× single query latency):
await ctx.connectors.sharepoint.GetItemById('GetParent', { /*...*/ });
await ctx.connectors.sharepoint.GetItems('GetMatchA', { /*...*/ });  // waits for GetParent
await ctx.connectors.sharepoint.GetItems('GetMatchB', { /*...*/ });  // waits for GetMatchA
await ctx.connectors.sharepoint.GetItems('GetMatchC', { /*...*/ });  // waits for GetMatchB

// ✅ Parallel — A, B, C all dispatch as soon as GetParent succeeds:
await ctx.connectors.sharepoint.GetItemById('GetParent', { /*...*/ });
/** @runAfter GetParent: Succeeded */
await ctx.connectors.sharepoint.GetItems('GetMatchA', { /*...*/ });
/** @runAfter GetParent: Succeeded */
await ctx.connectors.sharepoint.GetItems('GetMatchB', { /*...*/ });
/** @runAfter GetParent: Succeeded */
await ctx.connectors.sharepoint.GetItems('GetMatchC', { /*...*/ });

// Any action that consumes ALL three outputs must wait for all three:
/** @runAfter GetMatchA: Succeeded @runAfter GetMatchB: Succeeded @runAfter GetMatchC: Succeeded */
await ctx.compose('Merged', ctx.union(ctx.union(
  ctx.body('GetMatchA')?.['value'], ctx.body('GetMatchB')?.['value']
), ctx.body('GetMatchC')?.['value']));
```

**Without the join `@runAfter` on `Merged`**, the DSL would auto-chain it to `GetMatchC` only — and `union` would fire before `GetMatchA`/`GetMatchB` finished. Always pin a fan-in action's `@runAfter` to every parallel branch it reads from.

## Constructor Reference

The constructor defines metadata, connection references, and parameters. **Always place at the bottom of the class.**

```typescript
constructor(ctx: FlowContext) {
  // Required metadata
  ctx.flow.metadata = {
    "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
    contentVersion: "1.0.0.0",
    schemaVersion: "1.0.0.0",
  };

  // Connection references (required when using connectors)
  ctx.flow.connectionReferences = {
    shared_sharepointonline: {
      apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      connectionReferenceLogicalName: 'cr_sharepoint',
    },
    shared_office365: {
      apiId: '/providers/Microsoft.PowerApps/apis/shared_office365',
      connectionReferenceLogicalName: 'cr_office365',
    },
  };

  // Parameters: "Display Name (schemaName)": { type, defaultValue, metadata }
  // IMPORTANT: The key string here is what you use in ctx.parameters() — they must match EXACTLY.
  ctx.flow.parameters = {
    "$connections": { defaultValue: {}, type: "Object" },
    "$authentication": { defaultValue: {}, type: "SecureObject" },
    "Site URL (cr_SiteUrl)": {
      type: 'String',
      defaultValue: 'https://contoso.sharepoint.com/sites/MySite',
      metadata: { schemaName: 'cr_SiteUrl', description: 'SharePoint site URL' },
    },
  };
  // In run(): ctx.parameters('Site URL (cr_SiteUrl)')  ← must be exact key match

  // Child flows (optional): Define child workflows for name-based references
  // Use the name as second arg in ctx.callWorkflow() instead of a GUID
  ctx.flow.childFlows = {
    GenerateDocument: {
      workflowId: 'fa05dee0-12d5-f011-8544-7c1e523655f2',
      description: 'Generates Word document',
      parameters: {
        text: { title: 'Record ID', type: 'string', required: true },
        text_1: { title: 'Folder Path', type: 'string', required: true },
      },
    },
  };
  // In run(): await ctx.callWorkflow('RunChild', 'GenerateDocument', { text: '...', text_1: '...' })
}
```

### Connection Reference API IDs

| Connector | apiId |
|-----------|-------|
| SharePoint | `/providers/Microsoft.PowerApps/apis/shared_sharepointonline` |
| Dataverse | `/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps` |
| Office 365 | `/providers/Microsoft.PowerApps/apis/shared_office365` |
| Excel Online | `/providers/Microsoft.PowerApps/apis/shared_excelonlinebusiness` |
| Word Online | `/providers/Microsoft.PowerApps/apis/shared_wordonlinebusiness` |
| Approvals | `/providers/Microsoft.PowerApps/apis/shared_approvals` |
