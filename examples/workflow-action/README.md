# Workflow Action Example

This example demonstrates the Workflow action in FlowForger, which enables calling child/nested workflows for modular workflow design.

## Files

- [parent-flow.ff.ts](parent-flow.ff.ts) — HTTP-triggered orchestrator that calls two bundled child workflows. **Runnable locally** — the children are included under [flows/](flows/).
- [workflow-orchestration.ff.ts](workflow-orchestration.ff.ts) — Invoice-processing orchestration pattern chaining three child workflows. Compile-only (its children are referenced by placeholder GUIDs and not bundled).
- [flowforger.workflows.json](flowforger.workflows.json) — Maps child workflow GUIDs to local IR files for the engine.
- [flows/](flows/) — The bundled child workflows (as IR, named by GUID).

## Workflow Action Overview

The Workflow action allows you to:
- **Call child workflows** from a parent workflow
- **Pass parameters** to child workflows via the body
- **Create modular designs** by breaking complex workflows into smaller, reusable pieces
- **Orchestrate** multiple workflows in sequence
- **Reuse workflows** across different parent workflows

## Basic Usage

### Simple Child Workflow Call

```typescript
@Flow('parent-workflow')
class ParentWorkflow {
  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.callWorkflow('CallChild', '11111111-1111-1111-1111-111111111111');
  }
}
```

### With Parameters

```typescript
await ctx.callWorkflow('CallChild', '11111111-1111-1111-1111-111111111111', {
  param1: 'value1',
  param2: ctx.variables('myVar'),
  param3: ctx.eval(`@utcNow()`),
});
```

### With Headers (Optional)

```typescript
await ctx.callWorkflow(
  'CallChild',
  '11111111-1111-1111-1111-111111111111',
  { data: 'value' },
  { 'Content-Type': 'application/json' }
);
```

### Reading the Child's Result

A child workflow's response body is accessed with `ctx.body('<ActionName>')` — same as HTTP and connector actions:

```typescript
await ctx.callWorkflow('GetFolder', '11111111-1111-1111-1111-111111111111', {
  projectId: ctx.eval(`@triggerBody()?['projectId']`),
});

await ctx.compose('UseResult', {
  folderPath: ctx.eval(`@body('GetFolder')?['folderPath']`),
});
```

## Common Patterns

### 1. Orchestration Pattern

Sequential execution of multiple child workflows, passing each result forward:

```typescript
@Action()
async run(ctx: FlowContext) {
  // Step 1: Validate
  await ctx.callWorkflow('Validate', '11111111-1111-1111-1111-111111111111', {
    data: ctx.triggerBody(),
  });

  // Step 2: Process (uses result from validation)
  await ctx.callWorkflow('Process', '22222222-2222-2222-2222-222222222222', {
    validatedData: ctx.body('Validate'),
  });

  // Step 3: Store
  await ctx.callWorkflow('Store', '33333333-3333-3333-3333-333333333333', {
    processedData: ctx.body('Process'),
  });
}
```

### 2. Conditional Execution

Call different child workflows based on conditions:

```typescript
/** @action RouteCustomer @type if */
if (ctx.equals(ctx.eval(`@triggerBody()?['type']`), 'premium')) {
  await ctx.callWorkflow('ProcessPremium', '11111111-1111-1111-1111-111111111111', {
    customer: ctx.eval(`@triggerBody()?['customer']`),
  });
} else {
  await ctx.callWorkflow('ProcessStandard', '22222222-2222-2222-2222-222222222222', {
    customer: ctx.eval(`@triggerBody()?['customer']`),
  });
}
```

### 3. Batch Processing

Process items with a foreach loop:

```typescript
/** @action ProcessEachItem @type foreach */
for (const item of ctx.eval(`@triggerBody()?['items']`) ?? []) {
  await ctx.callWorkflow('ProcessItem', '11111111-1111-1111-1111-111111111111', {
    item: ctx.items('ProcessEachItem'),
  });
}
```

### 4. Error Handling

Wrap risky child workflow calls in a try/catch/finally scope pattern:

```typescript
/** @action TryProcessing @type scope */
{
  await ctx.callWorkflow('RiskyOperation', '11111111-1111-1111-1111-111111111111', {
    data: ctx.triggerBody(),
  });
}

/** @action HandleFailure @type scope @runAfter TryProcessing: Failed */
{
  await ctx.compose('LogError', { failed: true });
}

/** @action Finalize @type scope @runAfter TryProcessing: Succeeded, Failed, Skipped */
{
  await ctx.compose('Cleanup', { done: true });
}
```

### 5. Reusable Utilities

Create utility workflows that are called from multiple parents. The bundled [GetAbsoluteUrl child flow](flows/11111111-1111-1111-1111-111111111111.ir.json) is an example: it takes a text input and returns a computed URL, and any parent can call it:

```typescript
await ctx.callWorkflow('GetUrl', '11111111-1111-1111-1111-111111111111', {
  text: ctx.eval(`@triggerBody()?['projectId']`),
});
```

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# Run the parent orchestrator locally (child workflows resolved via flowforger.workflows.json)
npx flowforger run examples/workflow-action/parent-flow.ff.ts --workflows-config examples/workflow-action/flowforger.workflows.json

# Compile the invoice orchestration pattern to Logic Apps JSON (compile-only example)
npx flowforger compile examples/workflow-action/workflow-orchestration.ff.ts --out orchestration-clientdata.json

# Compile the parent orchestrator for deployment
npx flowforger compile examples/workflow-action/parent-flow.ff.ts --out parent-clientdata.json
```

## Generated Logic Apps JSON Structure

The Workflow action emits to Logic Apps format as:

```json
{
  "type": "Workflow",
  "inputs": {
    "host": {
      "workflowReferenceName": "child-workflow-guid"
    },
    "body": {
      "param1": "value1",
      "param2": "@variables('myVar')"
    }
  }
}
```

## Reverse Engineering

FlowForger can reverse-engineer Logic Apps JSON with Workflow actions back to DSL:

```bash
npx flowforger generate-dsl --in workflow-orchestration.clientdata.json --out flow.ff.ts --name WorkflowOrchestration
```

This will generate TypeScript DSL code with `ctx.callWorkflow()` method calls.

## Local Child Flow Execution

FlowForger supports **actual local execution** of child workflows. The engine can load and execute child flows from local files or Dataverse.

### CLI Usage

Run a parent flow with child flow support (paths shown from this directory; from repo root prefix with `examples/workflow-action/`):

```bash
# Run with workflow configuration file
npx flowforger run parent-flow.ff.ts \
  --workflows-config flowforger.workflows.json

# Or use convention-based lookup (finds flows in ./flows directory by GUID filename)
npx flowforger run parent-flow.ff.ts \
  --workflows-dir ./flows

# Strict mode: fail if child flows are missing
npx flowforger run parent-flow.ff.ts \
  --workflows-config flowforger.workflows.json \
  --strict-workflows

# With Dataverse integration (fetch child flows from Dataverse)
npx flowforger run parent-flow.ff.ts \
  --workflows-config flowforger.workflows.json \
  --dv-url https://your-org.crm.dynamics.com \
  --dv-token <YOUR_TOKEN> \
  --cache-workflows
```

Substitute `flowforger` (after `npm i -g flowforger`) or `node packages/cli/dist/index.js` for `npx flowforger` as you prefer.

### Configuration File Format

Create `flowforger.workflows.json` to map workflow GUIDs to local IR files (child workflows are kept as IR because their filenames must be the Power Automate workflow GUID):

```json
{
  "workflows": {
    "11111111-1111-1111-1111-111111111111": "./flows/11111111-1111-1111-1111-111111111111.ir.json",
    "22222222-2222-2222-2222-222222222222": "./flows/22222222-2222-2222-2222-222222222222.ir.json"
  }
}
```

### Convention-Based Lookup

Alternatively, organize child flows in a directory using the GUID as filename:

```
flows/
  11111111-1111-1111-1111-111111111111.ir.json
  22222222-2222-2222-2222-222222222222.ir.json
```

Then run:
```bash
npx flowforger run parent-flow.ff.ts --workflows-dir ./flows
```

### Web App Usage

The web app supports child flow execution automatically:

1. **Create Local Flows**: Create child flows in the Local Flow Editor
2. **Copy GUID**: Each flow has a GUID displayed in the editor (with copy button)
3. **Reference in Parent**: Use `ctx.callWorkflow('ActionName', '<GUID>', { params })` in the parent flow
4. **Run**: The runner will automatically resolve and execute child flows from IndexedDB
5. **Dataverse Integration**: If connected to Dataverse, child flows can be fetched and cached automatically

**Flow Picker UI**: Click the "🔗 Add Child Flow" button in the Local Flow Editor to browse and select child flows from a modal picker.

### Execution Features

- **Nested Traces**: Child flow execution is captured in the parent's trace with full detail
- **Isolated Context**: Each child flow runs in an isolated context (separate variables)
- **Recursive Support**: Child flows can call other child flows (nested execution)
- **Error Handling**: Errors in child flows propagate to the parent (or warn in non-strict mode)
- **Dataverse Caching**: Flows fetched from Dataverse are cached in IndexedDB for offline use

### Resolution Strategy

The engine resolves child flows in this order:

1. **Custom Loader** (web app: IndexedDB)
2. **Config File Mapping** (CLI: flowforger.workflows.json)
3. **Convention-Based** (CLI: workflows-dir)
4. **Dataverse Fetch** (if credentials provided)

### Example Run

Using the example in this directory:

```bash
cd examples/workflow-action
npx flowforger run parent-flow.ff.ts --workflows-config flowforger.workflows.json
```

You should see output like:

```json
{
  "status": "Succeeded",
  "trace": [
    { "name": "When_a_HTTP_request_is_received", "status": "Succeeded" },
    { "name": "InitializeData", "status": "Succeeded" },
    {
      "name": "Call_GetAbsoluteUrl",
      "status": "Succeeded",
      "outputs": {
        "childWorkflowName": "GetAbsoluteUrl",
        "status": "Succeeded",
        "body": { "absoluteurl": "https://sharepoint.com/PROG-2025-001" },
        "trace": [ /* nested child flow trace */ ]
      }
    },
    {
      "name": "Call_ProcessDocument",
      "status": "Succeeded",
      "outputs": {
        "childWorkflowName": "ProcessDocument",
        "status": "Succeeded",
        "trace": [ /* nested child flow trace */ ]
      }
    },
    { "name": "Response", "status": "Succeeded" }
  ]
}
```

## Engine Behavior

The FlowForger engine **fully executes** child workflows locally:
- **Loads child flows** from local files or Dataverse
- **Evaluates expressions** in the body parameters
- **Executes child workflow** recursively with isolated context
- **Merges traces** for complete execution visibility
- **Returns actual results** from child flow execution

For production use, deploy to Power Automate or Azure Logic Apps.

## Benefits of Modular Workflows

- **Reusability** — Write once, use in multiple parent workflows; reduce duplication
- **Maintainability** — Update child workflow logic in one place; clear separation of concerns
- **Testing** — Test child workflows independently; easier to debug smaller units
- **Organization** — Break complex workflows into manageable pieces
- **Team Collaboration** — Different teams can own different child workflows with clear interfaces

## Real-World Use Cases

1. **Invoice Processing**: Call separate workflows for validation, generation, and storage
2. **Approval Workflows**: Reusable approval child workflow called from multiple processes
3. **Data Transformation**: Common transformation utilities as child workflows
4. **Notification Service**: Centralized notification workflow called by many parents
5. **Document Generation**: Template filling as a reusable child workflow
6. **Integration Patterns**: Child workflows for external system integrations

## Workflow References

In Power Automate/Logic Apps, workflows are referenced by:
- **GUID**: Unique identifier (e.g., `11111111-1111-1111-1111-111111111111`)
- **Name**: Logical name in the solution

FlowForger's `workflowReferenceName` parameter accepts either format.

## Implementation Details

Workflow action support includes:

- **IR Types** (`@flowforger/ir`): `WorkflowActionInputs` interface in ActionNode
- **DSL** (`@flowforger/dsl-native`): `ctx.callWorkflow(name, workflowRef, body?, headers?)` method
- **Emitter** (`@flowforger/emitter-logicapps`): Converts to Logic Apps Workflow action
- **Generator** (`@flowforger/dsl-native`): Reverse-engineers Workflow actions back to DSL
- **Engine** (`@flowforger/engine`): Loads and executes child flows locally

This makes Workflow actions fully supported across the entire FlowForger toolchain.
