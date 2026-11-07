# Child Flows: Parent and Children in the DSL

A parent flow that calls three child flows, all written in the FlowForger DSL in this folder. The whole graph runs locally with one command and no credentials, and what the parent sees from each call is what the cloud hands it.

## Files

| File | Flow | What it does |
|---|---|---|
| [order-intake.ff.ts](order-intake.ff.ts) | Order Intake (parent) | HTTP trigger with an order; calls a child once, a child per order line in a loop, and a child inside a try/catch/finally; responds with the priced order |
| [children/build-reference.ff.ts](children/build-reference.ff.ts) | Build Reference Number | A pure utility: prefix + customer → `ORD-20261107-ACME-4F2A` |
| [children/validate-order-line.ff.ts](children/validate-order-line.ff.ts) | Validate Order Line | Checks sku, quantity and unit price; answers `ok`, the priced line and a `reason` |
| [children/calculate-shipping.ff.ts](children/calculate-shipping.ff.ts) | Calculate Shipping | A cost by region; an unknown region answers 400, so the parent's call fails |
| [payloads/order.json](payloads/order.json) | | Four lines, two of them invalid, region EU |
| [payloads/order-unknown-region.json](payloads/order-unknown-region.json) | | Region MARS: takes the catch path |
| [mocks/calculate-shipping.json](mocks/calculate-shipping.json) | | A `{ statusCode, body }` answer to mock the shipping child away |

## How child flows work, and how FlowForger links them

In Power Automate a child flow is a flow with the **Manually trigger a flow** trigger and a **Respond to a PowerApp or flow** action. The parent calls it with **Run a Child Flow**, passing the trigger inputs as the body, and receives the first Response. In the DSL:

```typescript
// Child: typed inputs on the trigger, typed outputs on the response
@ManualTrigger({ schema: { type: 'object', properties: { prefix: { type: 'string', 'x-ms-dynamically-added': true, ... } }, required: ['prefix'] } })
trigger() {}
...
await ctx.response('Respond_to_parent', 200, { reference: ... }, undefined, { type: 'object', properties: { reference: { type: 'string', 'x-ms-dynamically-added': true } } }, 'PowerApp');

// Parent: call by name, read the answer with ctx.body()
await ctx.callWorkflow('Build_reference', 'Build Reference Number', { prefix: 'ORD', customer: ctx.triggerBody()?.['customer']?.['id'] });
await ctx.compose('Reference', ctx.body('Build_reference')?.['reference']);
```

The name resolves through `ctx.flow.childFlows` in the parent's constructor:

```typescript
ctx.flow.childFlows = {
  'Build Reference Number': {
    workflowId: '00000000-0000-0000-0000-000000000001',   // what the deployed parent calls
    dslPath: 'children/build-reference.ff.ts',            // what a local run compiles instead
    parameters: { prefix: { title: 'prefix', type: 'string', required: true }, ... },
  },
};
```

`workflowId` goes into the compiled Logic Apps JSON (`host.workflowReferenceName`). `dslPath`, relative to the parent file, is what `flowforger run` compiles and executes when it reaches the call, with its own variables and its own nested trace. Without `dslPath` the CLI looks for `<name>.ff.ts` next to the parent, then for a `--workflows-config` mapping or a Dataverse fetch. `flowforger pull --all` writes this layout for you: every parent's `callWorkflow` is rewritten from a GUID to the child's name, with `dslPath` pointing at the pulled child.

## What the parent gets back

Measured in the cloud by the conformance suite and reproduced by the local engine:

| The child... | The call in the parent |
|---|---|
| responds with a status below 400 | Succeeds. `ctx.body('Call')` is the response body, `outputs('Call')?['statusCode']` the status |
| responds with a status of 400 or more | **Fails**, with the status name as its code (`BadRequest`) and the response kept as its outputs, so a catch scope can read `body('Call')?['error']` |
| ends without any Response, even successfully (a `Terminate` Succeeded, or just no Response action) | **Fails** with `502` `BadGateway` and a `NoResponse` error body |
| responds and then fails | Succeeds: the parent already has its answer |
| receives inputs its schema does not expect | Runs anyway: neither the trigger schema nor the response schema converts or validates anything |

Under the default retry policy the cloud retries a child that fails without responding for many minutes, starting it again each time. Every call in this example therefore carries `@retryPolicy {"type":"none"}`; locally a call is made once either way.

## Run it

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# Happy path: two lines accepted, two rejected, EU shipping
npx flowforger run examples/child-flows/order-intake.ff.ts --in examples/child-flows/payloads/order.json

# Catch path: the shipping child answers 400, the parent falls back to a flat rate
npx flowforger run examples/child-flows/order-intake.ff.ts --in examples/child-flows/payloads/order-unknown-region.json
```

Each child runs nested inside the parent's trace, so the loop shows one child run per line:

```
  ✓ Build_reference → {"statusCode":200,"headers":{...},"body":{"reference":"ORD-20261107-ACME-275E",...}}
  ✓ For_each_line — 4 iterations
    [1/4] {"sku":"KB-100","quantity":2,"unitPrice":49.5}
      ✓ Validate_line → {"statusCode":200,...,"body":{"ok":true,"sku":"KB-100","quantity":2,"lineTotal":99,"reason":""}}
      ✓ Line_is_valid condition → true (then branch)
        ✓ Append_accepted_line → [{"ok":true,"sku":"KB-100",...}]
        ✓ Add_line_total → 99
    [2/4] {"sku":"","quantity":1,"unitPrice":10}
      ✓ Validate_line → {...,"body":{"ok":false,"sku":"","quantity":1,"lineTotal":0,"reason":"sku is required"}}
      ✓ Line_is_valid condition → false (else branch)
        ✓ Append_rejected_line → [{"ok":false,"sku":"","reason":"sku is required"}]
  ...
  ✓ Try_shipping → {"scopeStatus":"Succeeded"}
    ✓ Calculate_shipping → {"statusCode":200,...,"body":{"cost":11.5,"region":"EU","carrier":"Contoso Logistics"}}
    ✓ Shipping_cost → 11.5
  ↷ Catch_shipping
  ✓ Finally_shipping → {"scopeStatus":"Succeeded"}
    ✓ Effective_shipping_cost → 11.5
  ✓ Order_accepted → {"reference":"ORD-20261107-ACME-275E","subtotal":288,"shipping":11.5,"total":299.5,...}
```

With the unknown region the call fails and the catch scope reads what failed:

```
  ✗ Try_shipping → {"scopeStatus":"Failed"}
    ✗ Calculate_shipping → {"statusCode":400,...,"body":{"error":"No shipping rate for region MARS"}}
      Child flow 'Calculate Shipping' answered 400
    ↷ Shipping_cost
  ✓ Catch_shipping → {"scopeStatus":"Succeeded"}
    ✓ Failed_shipping_actions → {"body":[{"name":"Calculate_shipping","status":"Failed","code":"BadRequest",...}]}
    ✓ Shipping_error → {"failedAction":"Calculate_shipping","code":"BadRequest","statusCode":400,"reason":"No shipping rate for region MARS"}
    ✓ Fallback_shipping_cost → 25
  ✓ Finally_shipping → {"scopeStatus":"Succeeded"}
    ✓ Effective_shipping_cost → 25
  ✓ Order_accepted → {...,"shipping":25,"shippingNote":"No shipping rate for region MARS","total":74.5}
```

Pipe the command (or pass `--json`) for the same trace as JSON: a child call's entry carries `inputs` (the body it was invoked with) and `outputs` (`{ statusCode, headers, body }`), and the child's own actions are nested under it.

Two things in the parent worth reading: the `Finally_shipping` scope depends on `Catch_shipping` with every status (`Succeeded, Failed, Skipped`), so it runs on both paths **and** both the try's and the catch's outputs are on its `runAfter` path, which is what lets `Effective_shipping_cost` read either one. And the loop is sequential (`repetitions: 1`), because its body appends to variables; the cloud would otherwise run the four child calls in parallel.

## Test it

The calls are external actions, so the run flags that guard external calls apply to them:

```bash
# Mock a child away: the call does not run, later actions read the file's { statusCode, body }
npx flowforger run examples/child-flows/order-intake.ff.ts --in examples/child-flows/payloads/order-unknown-region.json --mock Calculate_shipping=examples/child-flows/mocks/calculate-shipping.json

# Stop before a call and see the exact body it would have sent (exit code 3)
npx flowforger run examples/child-flows/order-intake.ff.ts --in examples/child-flows/payloads/order.json --stop-before Calculate_shipping

# Deny by default: only the listed calls may run; the first other external action stops the run
npx flowforger run examples/child-flows/order-intake.ff.ts --in examples/child-flows/payloads/order.json --live Build_reference,Validate_line
```

Once the flows are deployed, `flowforger run order-intake.ff.ts --auth --replay-run <runId>` pins every child call to what that cloud run recorded and recomputes the rest locally. The [local-testing example](../local-testing/) walks through all of these against one flow.

## Deploy it

Children first, because the parent needs their ids:

```bash
# 1. Push each child. A new flow is created as Draft and its workflowId is written into the child's @Flow decorator.
npx flowforger push --file examples/child-flows/children/build-reference.ff.ts --solution MySolution --url https://<org>.crm.dynamics.com --auth
npx flowforger push --file examples/child-flows/children/validate-order-line.ff.ts --solution MySolution --url https://<org>.crm.dynamics.com --auth
npx flowforger push --file examples/child-flows/children/calculate-shipping.ff.ts --solution MySolution --url https://<org>.crm.dynamics.com --auth

# 2. Copy each printed id into the parent's childFlows[...].workflowId, then push the parent.
npx flowforger push --file examples/child-flows/order-intake.ff.ts --solution MySolution --url https://<org>.crm.dynamics.com --auth

# 3. Turn the children on before the parent, then run the parent once in the cloud as the final check.
```

`push` never activates a flow. In CI, `--no-create` makes a push fail instead of creating a duplicate when the flow is missing.

Children that use connectors need one more thing: the parent hands its connections down in the `X-MS-APIM-Tokens` trigger header, and every connector call in the child passes that token as its `authentication` argument. A child pulled from an environment already carries it; see the connectors reference in the skills (`connectors.md`, "The authentication argument and X-MS-APIM-Tokens") before writing one by hand.
