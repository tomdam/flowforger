# FlowForger DSL — Conformance Rules

These are the constraints a **context-free grammar cannot express** — they depend on
cross-statement context (name uniqueness), control-flow semantics (try/catch wiring), or
downstream limits (Dataverse field sizes). A `.ff.ts` file can be perfectly valid TypeScript,
match the [recognized subset](./flowforger-dsl.ebnf), and still be a non-conformant flow if it
violates any rule below.

Each rule lists **where it is enforced or originates** so the spec can be kept honest. The
canonical authoring rules live in [`skills/flowforger/SKILL.md`](../../skills/flowforger/SKILL.md);
this document is the spec-style restatement. To see every rule applied in one coherent flow,
read [`canonical-example.ff.ts`](./canonical-example.ff.ts).

Severity legend:
- 🔴 **Hard** — produces a broken or unpublishable flow.
- 🟠 **Soft** — produces incorrect IR / silently wrong behavior.

---

## R1 — Action names must be globally unique 🔴

Every action, trigger, and control node must have a unique `name`, **including across switch
cases** (each case is a separate Logic Apps scope, but output references after the switch are
ambiguous if names collide).

```ts
// ❌ 'Set_Config' reused across cases
case 'A': await ctx.compose('Set_Config', 'A'); break;
case 'B': await ctx.compose('Set_Config', 'B'); break;

// ✅ unique per case
case 'A': await ctx.compose('Set_Config_TypeA', 'A'); break;
case 'B': await ctx.compose('Set_Config_TypeB', 'B'); break;
```

*Origin:* Logic Apps action-name namespace. *Enforce at:* `@flowforger/validator`.

---

## R2 — No declarations outside the flow class 🔴

No top-level `const`/`let`/`function` above the class. Externalize values as flow parameters in
the constructor and read them with `ctx.parameters('<exact key>')`.

```ts
// ❌
const SITE_URL = 'https://contoso.sharepoint.com/sites/x';

// ✅ constructor
ctx.flow.parameters = {
  "Site URL (cr_SiteUrl)": { type: 'String', defaultValue: '...', metadata: { schemaName: 'cr_SiteUrl' } }
};
// run()
ctx.parameters('Site URL (cr_SiteUrl)')
```

*Origin:* only the `@Flow` class is walked (`findFlowClass`). Top-level statements never reach IR.

---

## R3 — `ctx.parameters('X')` must match the parameter key EXACTLY 🟠

The transformer does **zero** name normalization. The string passed to `ctx.parameters(...)`
(and `parameters('...')` inside `ctx.eval`) must be byte-identical to the key in
`ctx.flow.parameters`.

```ts
// key: "Site URL (cr_SiteUrl)"
ctx.parameters('SiteUrl')                 // ❌ won't resolve
ctx.parameters('Site URL (cr_SiteUrl)')   // ✅
```

*Origin:* expression-transformer passes the literal through unchanged.

---

## R4 — `@action` is the *only* way to name variables/control flow, but it is optional 🟠

Two separate facts:

1. **Never put `@action` on a named action call.** `ctx.compose()` / `ctx.http()` / connector
   calls take their name as the first argument; an `@action` above them is wrong (ignored at
   best). Variable declarations and control-flow statements have no name argument, so `@action`
   is the *only* way to name them.
2. **`@action` is optional, not required.** When it is absent the transformer auto-derives a
   name — `Initialize_<var>`, `Set_<var>`, `Increment_<var>`, `Decrement_<var>`, `Append_<var>`
   for variables; `Condition` / `ForEach_<loopVar>` / `Switch` / `DoUntil` / `Case_<value>` for
   control flow. Providing one is *recommended*, because the defaults are generic and collide
   easily (two un-annotated `if`s both become `Condition`, violating R1 above),
   and a descriptive name is what later `ctx.outputs()`/`ctx.body()` references depend on.

`arr.push()`, `x++`, and `x--` **ignore** `@action` entirely — they are always auto-named
`Append_<var>` / `Increment_<var>` / `Decrement_<var>`. Rename the variable to change them.

```ts
await ctx.compose('Get_Data', { value: 1 });   // ✅ no JSDoc (the name is the first arg)

let counter: number = 0;                         // ✅ valid — auto-named "Initialize_counter"

/** @action Initialize_counter */
let counter2: number = 0;                        // ✅ valid — @action overrides the default name

if (cond) { /* ... */ }                          // ✅ valid — auto-named "Condition"
/** @action CheckStatus @type if */
if (cond) { /* ... */ }                          // ✅ recommended — explicit, unique name
```

**`@type` follows a different rule:** it is **required only for `scope`** (a bare `{ }` block
becomes a Scope only with `@type scope`; without it the block is flattened and its actions
inlined). `if` / `foreach` / `switch` / `until` are recognized **structurally** by their
TypeScript statement kind, so `@type` there is optional/advisory (still recommended for clarity
and round-trip parity).

*Origin:* `action-collector.ts` (named actions) vs `variable-tracker.ts` /
`control-flow-analyzer.ts` (auto-named fallbacks); `transformer/index.ts` dispatches control flow
by statement kind and gates Scope on `@type scope`.

---

## R5 — Never use `return`; use `ctx.terminate()` 🔴

`return` is not lowered. Exit early with `ctx.terminate('Name', status)`.

```ts
// ❌
if (cond) { return; }

// ✅
/** @action Stop @type if */
if (cond) { await ctx.terminate('Stop', 'Cancelled'); }
```

`terminate` status sub-rules:
- `'Succeeded'` / `'Cancelled'` → **do not** pass a third `runError` argument (Power Automate
  rejects it → "unknown error" on publish).
- `'Failed'` → may pass `{ code, message }`; at least one must be non-empty.

*Origin:* no IR mapping for `ReturnStatement`; Dataverse publish validation.

---

## R6 — Try/Catch must have a Finally scope (or explicit multi-status `@runAfter`) 🔴

The transformer auto-chains each action `runAfter` the previous one with `["Succeeded"]`. A
catch scope (`@runAfter Try: Failed`) only runs on failure, so anything after it is skipped on
the **success** path — silently breaking the flow in half.

```ts
/** @action TryBlock @type scope */
{ await ctx.http('RiskyCall', { method: 'GET', url: '...' }); }

/** @action CatchBlock @type scope @runAfter TryBlock: Failed */
{ await ctx.compose('Error', { failed: true }); }

// ✅ FinallyBlock runs on ALL outcomes, so auto-chaining after it is safe
/** @action FinallyBlock @type scope @runAfter TryBlock: Succeeded, Failed, Skipped */
{ await ctx.compose('Cleanup', { done: true }); }

await ctx.response('Response', 200, { done: true });
```

Generalization: **any** action whose `@runAfter` uses a non-default status leaves the success
path dangling; add a finally scope or an explicit multi-status `@runAfter` on the next action.

*Origin:* auto-`runAfter` chaining in the transformer.

---

## R7 — Use `&&` / `||` in if-conditions, not top-level `ctx.and()` / `ctx.or()` 🔴

`&&`/`||` are lowered to PA `and()`/`or()`. But `ctx.and(...)`/`ctx.or(...)` as the **outermost**
if-condition can fail to transform and dump raw TypeScript into the output. Nested `ctx.*`
helpers (`ctx.not`, `ctx.empty`, `ctx.greater`, …) are fine **as arguments**.

```ts
// ❌ outermost ctx.and
if (ctx.and(ctx.not(ctx.empty(x)), ctx.greater(y, 0))) { }

// ✅ && with ctx.* helpers as operands
if (ctx.not(ctx.empty(x)) && ctx.greater(y, 0)) { }
```

*Origin:* `transformCondition` handles binary `&&`/`||`; top-level `ctx.and`/`ctx.or` calls are
not special-cased.

---

## R8 — Append to array variables with `.push()` only 🟠

`AppendToArrayVariable` maps **only** from `arr.push(item)`. Spread-reassignment, `concat`, and
plain reassignment are not recognized and emit raw TypeScript or replace the whole array.

```ts
/** @action Initialize_userEmails */
let userEmails: string[] = [];

userEmails = [...userEmails, x];      // ❌ raw "...userEmails" string
userEmails = userEmails.concat([x]);  // ❌ becomes SetVariable, not append
userEmails.push(x);                   // ✅ AppendToArrayVariable
```

*Origin:* `variable-tracker.ts` recognizes the `.push()` call pattern only.

---

## R9 — Action descriptions must be ≤ 256 characters 🔴

Any plain comment (`//` or `/* */`) or `@description` text above an action becomes the IR
`description`, copied verbatim into Logic Apps JSON. Dataverse enforces a **256-char** limit;
overflow fails at **publish** time with an opaque error (not at compile time).

- Structural tags (`@action`, `@type`, `@runAfter`, `@limit`, `@metadata`, …) are stripped and
  do **not** count.
- A plain comment placed above a `/** @action … */` block is folded into the description and
  **does** count.

```ts
// ✅ short, single sentence
// Build the approval payload from the order trigger body.
await ctx.compose('BuildPayload', { order: ctx.triggerBody() });
```

Applies equally to trigger descriptions and the flow-level description.

*Origin:* `parseDescriptionFromJSDoc` / `getLeadingPlainCommentText`; Dataverse field limit.

---

## R10 — Don't `@{...}`-wrap values that must stay arrays/objects/numbers 🟠

In Power Automate `@expr` preserves type; `@{expr}` coerces to **string**. Wrapping a value that
must remain an array/object/number (foreach sources, array-variable assignments, JSON) in
`@{...}` — via `ctx.braced(...)` or `ctx.eval('@{...}')` — breaks it.

```ts
await ctx.compose('AllItems', ctx.union(a, b));                    // ✅ array preserved
myArray = ctx.eval(`@union(variables('myArray'), createArray(x))`); // ✅ array preserved

await ctx.compose('AllItems', ctx.braced(ctx.union(a, b)));        // ❌ stringified
myArray = ctx.eval(`@{union(...)}`);                               // ❌ stringified
```

Use `@{...}` / `ctx.braced()` **only** for intentional string output (display strings, URI parts).

*Origin:* Power Automate expression evaluation semantics.

---

## R11 — Exactly one trigger and one action method 🔴

A conformant flow class has exactly one trigger member (`@HttpTrigger` / `@ManualTrigger` /
`@RecurrenceTrigger` / `@ConnectorTrigger`) and exactly one `@Action` method (conventionally
`run`). Missing either is a transform error.

*Origin:* `findTriggerMethod` / `findActionMethod` throw when absent.

---

## R12 — Read results with the right accessor: `body()` vs `outputs()` 🟠

The accessor must match how Power Automate nests the action's result, or the reference
resolves to `null` at runtime (it compiles fine — there is no static error).

| Action kind | Accessor | Why |
|-------------|----------|-----|
| **Compose** | `ctx.outputs('Name')` | Compose puts the value directly in `outputs`. |
| **HTTP** | `ctx.body('Name')` | The response payload is under `outputs.body`. |
| **Connector** | `ctx.body('Name')` | Connector responses are under `outputs.body`. |
| **Child workflow** | `ctx.body('Name')` | The child's response is under `outputs.body`. |

```ts
await ctx.compose('Payload', { name: 'test' });
ctx.outputs('Payload')?.['name']               // ✅ Compose → outputs()

await ctx.http('Fetch', { method: 'GET', url: '...' });
ctx.body('Fetch')?.['name']                    // ✅ HTTP → body()

await ctx.connectors.sharepoint.GetItems('Items', {/*...*/}, 'shared_sharepointonline');
ctx.body('Items')?.['value']                   // ✅ Connector → body()
```

`ctx.outputs('Name')?.['body/...']` also works for any action (it walks the full outputs
path), but the table above is the idiomatic form.

*Origin:* Logic Apps result envelope shape (`outputs` vs `outputs.body`).

---

## R13 — `@ManualTrigger` inputs need `"x-ms-dynamically-added": true` 🔴

Every property under a `@ManualTrigger` `schema.properties` MUST include
`"x-ms-dynamically-added": true`. Without it the new Power Automate maker-portal designer
silently **hides** the input — the flow still runs, but makers cannot see or edit the
parameter. Also set `"x-ms-content-hint"` (e.g. `"TEXT"`, `"EMAIL"`, `"FILE"`) and a
`title` + `description` so the designer renders a proper label.

```ts
@ManualTrigger()
trigger(ctx: FlowContext) {
  return {
    schema: {
      type: 'object',
      properties: {
        recordId: {
          title: 'Record Id',
          type: 'string',
          description: 'Record Id',
          'x-ms-dynamically-added': true,   // ✅ required for designer visibility
          'x-ms-content-hint': 'TEXT',
        },
      },
      required: ['recordId'],
    },
  };
}
```

*Origin:* maker-portal designer input-discovery contract. *See:* [dsl-syntax.md](../../skills/flowforger/dsl-syntax.md#manual-trigger).

---

## R14 — `ctx.response` PowerApp / VirtualAgent outputs need a schema with `"x-ms-dynamically-added": true` 🔴

When a response is consumed by Power Apps or a Virtual Agent (e.g. "Respond to a PowerApp
or flow"), pass a `schema` as the **5th** argument and `'PowerApp'` (or `'VirtualAgent'`)
as the **6th**. The 4th argument is `headers` — pass `undefined` if none. Every property
under `schema.properties` MUST include `"x-ms-dynamically-added": true`, or the designer
hides the output and Power Apps cannot bind to it.

```ts
await ctx.response('Respond', 200, {
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

A plain HTTP response (no Power Apps / Virtual Agent consumer) does not need the schema:
`await ctx.response('Respond', 200, { ok: true });`

*Origin:* maker-portal designer output-discovery contract. *See:* [dsl-syntax.md](../../skills/flowforger/dsl-syntax.md#response).

---

### Quick reference

| Rule | Summary | Severity |
|------|---------|----------|
| R1 | Globally unique action names (incl. across cases) | 🔴 |
| R2 | No declarations outside the flow class | 🔴 |
| R3 | `ctx.parameters()` exact key match | 🟠 |
| R4 | `@action` optional (auto-named) & never on named calls; `@type` required only for scope | 🟠 |
| R5 | No `return`; use `ctx.terminate()` | 🔴 |
| R6 | Try/Catch needs a Finally (or explicit `@runAfter`) | 🔴 |
| R7 | `&&`/`||` not top-level `ctx.and()`/`ctx.or()` | 🔴 |
| R8 | Append arrays with `.push()` only | 🟠 |
| R9 | Descriptions ≤ 256 chars | 🔴 |
| R10 | No `@{...}` around array/object/number values | 🟠 |
| R11 | Exactly one trigger + one action method | 🔴 |
| R12 | `body()` for HTTP/connector/child-flow, `outputs()` for Compose | 🟠 |
| R13 | `@ManualTrigger` inputs need `"x-ms-dynamically-added": true` | 🔴 |
| R14 | `ctx.response` PowerApp/VirtualAgent schema needs `"x-ms-dynamically-added": true` | 🔴 |
