# FlowForger Examples

> All examples follow the [critical rules](SKILL.md#critical-rules-source-of-truth): unique action names, constructor at bottom, `@action` only for variables/control flow, no return statements.

## Example 1: SharePoint List Processing (Complete)

This is a complete example showing the full flow structure. Subsequent examples show only the `run()` method for brevity.

```typescript
@Flow('ProcessSharePointItems')
class ProcessSharePointItems {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    /** @action Initialize_processedCount */
    let processedCount: number = 0;

    // IMPORTANT: ctx.parameters() name must EXACTLY match the key in ctx.flow.parameters
    await ctx.connectors.sharepoint.GetItems('GetPendingTasks', {
      dataset: ctx.parameters('Site URL (cr_SiteUrl)'),
      table: ctx.parameters('Tasks List ID (cr_TasksListId)'),
      '$filter': "Status eq 'Pending'",
      '$top': 50
    }, 'shared_sharepointonline');

    /** @action ProcessEachTask @type foreach */
    for (const item of ctx.body('GetPendingTasks')?.['value'] ?? []) {
      await ctx.connectors.sharepoint.UpdateItem('MarkTaskProcessing', {
        dataset: ctx.parameters('Site URL (cr_SiteUrl)'),
        table: ctx.parameters('Tasks List ID (cr_TasksListId)'),
        id: item?.['ID'],
        'item/Status/Value': 'Processing'
      }, 'shared_sharepointonline');

      /** @action IncrementProcessedCount */
      processedCount = processedCount + 1;
    }

    await ctx.response('ReturnResult', 200, { processed: ctx.variables('processedCount') });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
      contentVersion: "1.0.0.0",
      schemaVersion: "1.0.0.0",
    };
    ctx.flow.connectionReferences = {
      shared_sharepointonline: {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
        connectionReferenceLogicalName: 'cr_sharepoint',
      },
    };
    ctx.flow.parameters = {
      "$connections": { defaultValue: {}, type: "Object" },
      "$authentication": { defaultValue: {}, type: "SecureObject" },
      // Key names here must match EXACTLY what's used in ctx.parameters()
      "Site URL (cr_SiteUrl)": {
        type: 'String',
        defaultValue: 'https://contoso.sharepoint.com/sites/Tasks',
        metadata: { schemaName: 'cr_SiteUrl', description: 'SharePoint site URL' },
      },
      "Tasks List ID (cr_TasksListId)": {
        type: 'String',
        defaultValue: '{list-guid}',
        metadata: { schemaName: 'cr_TasksListId', description: 'Tasks list GUID' },
      },
    };
  }
}
```

---

**The following examples show only the `run()` method.** Each needs a trigger and constructor as shown above. Parameter names like `ctx.parameters('ManagerEmail')` assume a matching key `"ManagerEmail"` exists in `ctx.flow.parameters` in the constructor.

> **Do NOT add `import` statements.** `.ff.ts` files are consumed by the FlowForger transformer, not by `tsc` — decorators (`@Flow`, `@HttpTrigger`, …) and the `FlowContext` type are resolved by the transformer's symbol table, not by JS module resolution. Any `import { Flow, ... } from "@flowforger/dsl-native"` line at the top is dead weight that should be removed.

## Example 2: Conditional Logic with Email Notification

```typescript
async run(ctx: FlowContext) {
  /** @action Initialize_orderCategory */
  let orderCategory: string = '';

  /** @action EvaluateOrderAmount @type if */
  if (ctx.triggerBody()?.['amount'] > 1000) {
    /** @action SetHighValue */
    orderCategory = 'high-value';

    await ctx.connectors.office365.SendEmailV2('NotifyManagerHighValue', {
      'emailMessage/To': ctx.parameters('ManagerEmail'),
      'emailMessage/Subject': 'High Value Order Received',
      'emailMessage/Body': ctx.eval(`<p>Order Amount: $@{triggerBody()?['amount']}</p>`)
    }, 'shared_office365');
  } else {
    /** @action SetNormal */
    orderCategory = 'normal';
  }

  await ctx.response('ReturnCategory', 200, { category: ctx.variables('orderCategory') });
}
```

## Example 3: Error Handling with Scopes (Try/Catch)

> **CRITICAL:** A try/catch pattern **MUST** include a Finally scope (or explicit multi-dependency `@runAfter` on the next action). Without it, all actions after the catch block are skipped on the success path. See [Critical Rule 6](SKILL.md#6-trycatch-must-have-a-finally-scope-or-explicit-multi-dependency-runafter).

```typescript
async run(ctx: FlowContext) {
  /** @action Initialize_success */
  let success: boolean = false;

  /** @action TryProcess @type scope */
  {
    await ctx.http('CallExternalApi', {
      method: 'POST',
      url: ctx.parameters('ApiEndpoint'),
      body: ctx.triggerBody()
    });

    /** @action MarkSuccess */
    success = true;
  }

  /** @action HandleFailure @type scope @runAfter TryProcess: Failed */
  {
    await ctx.compose('CaptureError', { error: 'Processing failed', input: ctx.triggerBody() });
  }

  // ⚠️ Finalize MUST use @runAfter with Succeeded, Failed, Skipped
  // Without this, actions after HandleFailure would only run when TryProcess FAILS
  // (because the auto-chaining would set runAfter: { HandleFailure: ["Succeeded"] },
  // and HandleFailure is skipped when TryProcess succeeds)
  /** @action Finalize @type scope @runAfter TryProcess: Succeeded, Failed, Skipped */
  {
    /** @action CheckResult @type if */
    if (ctx.variables('success') === true) {
      await ctx.response('SuccessResponse', 200, { status: 'success' });
    } else {
      await ctx.response('FailureResponse', 500, { status: 'failed' });
    }
  }
}
```

## Example 4: Switch Statement Routing

```typescript
async run(ctx: FlowContext) {
  /** @action RouteByRegion @type switch */
  switch (ctx.triggerBody()?.['region']) {
    /** @action HandleUS @type case */
    case 'US':
      await ctx.http('ForwardToUS', {
        method: 'POST',
        url: ctx.parameters('USApiUrl'),
        body: ctx.triggerBody()
      });
      break;

    /** @action HandleEU @type case */
    case 'EU':
      await ctx.http('ForwardToEU', {
        method: 'POST',
        url: ctx.parameters('EUApiUrl'),
        body: ctx.triggerBody()
      });
      break;

    /** @action HandleDefault @type case */
    default:
      await ctx.http('ForwardToDefault', {
        method: 'POST',
        url: ctx.parameters('DefaultApiUrl'),
        body: ctx.triggerBody()
      });
  }

  await ctx.response('ReturnRoutingResult', 200, { routed: true });
}
```

## Example 5: Connector Trigger (SharePoint "When Item Created")

This example uses `@ConnectorTrigger` instead of `@HttpTrigger`:

```typescript
@Flow('OnNewSharePointItem')
class OnNewSharePointItem {
  @ConnectorTrigger()
  trigger(ctx: FlowContext) {
    return {
      connector: 'sharepoint',
      operation: 'GetOnNewItems',
      params: {
        dataset: ctx.parameters('Site URL (cr_SiteUrl)'),
        table: ctx.parameters('List ID (cr_ListId)')
      },
      connectionReferenceName: 'shared_sharepointonline',
      splitOn: "@triggerOutputs()?['body/value']",
      recurrence: { interval: 1, frequency: 'Minute' }
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.office365.SendEmailV2('NotifyNewItem', {
      'emailMessage/To': ctx.parameters('Notify Email (cr_NotifyEmail)'),
      'emailMessage/Subject': ctx.eval(`New item: @{triggerBody()?['Title']}`),
      'emailMessage/Body': ctx.eval(`<p>Created by @{triggerBody()?['Author/Claims']}</p>`)
    }, 'shared_office365');
  }

  // constructor with shared_sharepointonline and shared_office365 connection references
  // and matching parameter keys: "Site URL (cr_SiteUrl)", "List ID (cr_ListId)", "Notify Email (cr_NotifyEmail)"
}
```

## Example 6: Dataverse CRUD with Related Records

```typescript
async run(ctx: FlowContext) {
  await ctx.connectors.dataverse.CreateRecord('CreateAccount', {
    entityName: 'accounts',
    item: {
      name: ctx.triggerBody()?.['companyName'],
      telephone1: ctx.triggerBody()?.['phone']
    }
  }, 'shared_commondataserviceforapps');

  await ctx.connectors.dataverse.CreateRecord('CreateContact', {
    entityName: 'contacts',
    item: {
      firstname: ctx.triggerBody()?.['firstName'],
      lastname: ctx.triggerBody()?.['lastName'],
      'parentcustomerid_account@odata.bind': ctx.eval(`/accounts(@{outputs('CreateAccount')?['body/accountid']})`)
    }
  }, 'shared_commondataserviceforapps');

  await ctx.response('ReturnIds', 201, {
    accountId: ctx.outputs('CreateAccount')?.['body/accountid'],
    contactId: ctx.outputs('CreateContact')?.['body/contactid']
  });
}
```

## Example 7: Do-Until Loop (Polling)

```typescript
async run(ctx: FlowContext) {
  // Start an async job
  await ctx.http('StartJob', {
    method: 'POST',
    url: ctx.parameters('JobApiUrl'),
    body: ctx.triggerBody()
  });

  // Poll until the job completes
  /** @action PollJobStatus @type until */
  do {
    await ctx.http('CheckJobStatus', {
      method: 'GET',
      url: ctx.eval(`@{parameters('JobApiUrl')}/status/@{body('StartJob')?['jobId']}`)
    });
  } while (ctx.body('CheckJobStatus')?.['status'] !== 'complete');

  await ctx.response('ReturnJobResult', 200, ctx.body('CheckJobStatus'));
}
```

## Example 8: Merging Arrays for Foreach (Expression Types)

Shows how to merge multiple query results and iterate over them. **Important:** Never use `ctx.braced()` for compose values that feed into foreach — it converts arrays to strings.

```typescript
async run(ctx: FlowContext) {
  // Query multiple sources
  await ctx.connectors.sharepoint.GetItems('GetActiveItems', {
    dataset: ctx.parameters('Site URL (cr_SiteUrl)'),
    table: ctx.parameters('List ID (cr_ListId)'),
    '$filter': "Status eq 'Active'",
    '$top': 50
  }, 'shared_sharepointonline');

  await ctx.connectors.sharepoint.GetItems('GetPendingItems', {
    dataset: ctx.parameters('Site URL (cr_SiteUrl)'),
    table: ctx.parameters('List ID (cr_ListId)'),
    '$filter': "Status eq 'Pending'",
    '$top': 50
  }, 'shared_sharepointonline');

  // ✅ CORRECT: Pass union() directly — preserves array type for foreach
  await ctx.compose('AllItems', ctx.union(
    ctx.body('GetActiveItems')?.['value'],
    ctx.body('GetPendingItems')?.['value']
  ));

  // ❌ WRONG: ctx.braced() would convert the array to a string:
  // await ctx.compose('AllItems', ctx.braced(ctx.union(...)));

  /** @action ProcessAllItems @type foreach */
  for (const item of (ctx.outputs('AllItems') ?? [])) {
    await ctx.connectors.sharepoint.UpdateItem('UpdateItemStatus', {
      dataset: ctx.parameters('Site URL (cr_SiteUrl)'),
      table: ctx.parameters('List ID (cr_ListId)'),
      id: ctx.items('ProcessAllItems')?.['ID'],
      'item/Processed/Value': 'Yes'
    }, 'shared_sharepointonline');
  }
}
```

## Example 9: Parent Flow Calling Child Workflows

This example shows a parent flow that orchestrates child workflows using named references.

```typescript
@Flow('CreateInvoiceOrchestrator')
class CreateInvoiceOrchestrator {
  @ConnectorTrigger()
  trigger(ctx: FlowContext) {
    return {
      connector: 'commondataserviceforapps',
      operation: 'SubscribeWebhookTrigger',
      params: { subscriptionRequest: { entityname: 'brk_posteniminkasso' } },
      connectionReferenceName: 'shared_commondataserviceforapps',
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    // Call child flow by name (defined in constructor)
    await ctx.callWorkflow('Run_FillWordTemplate', 'FillWordTemplate', {
      text: ctx.triggerOutputs()?.['body/_brk_versicherungsperiode_value'],
      text_1: ctx.triggerOutputs()?.['body/_brk_buchung_value'],
      text_2: ctx.variables('varVersicherungsnehmerId'),
    });

    // Use child flow result
    await ctx.compose('DocumentPath', ctx.body('Run_FillWordTemplate')?.['filePath']);

    // Call another child flow
    await ctx.callWorkflow('Run_CreateEmailDraft', 'CreateEmailDraft', {
      text: ctx.triggerOutputs()?.['body/brk_posteniminkassoid'],
      text_1: ctx.outputs('DocumentPath'),
    });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      schemaVersion: '1.0.0.0',
      contentVersion: '1.0.0.0',
    };
    ctx.flow.connectionReferences = {
      shared_commondataserviceforapps: {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
        connectionReferenceLogicalName: 'cr_dataverse',
      },
    };
    ctx.flow.childFlows = {
      FillWordTemplate: {
        workflowId: 'fa05dee0-12d5-f011-8544-7c1e523655f2',
        description: 'Generates Word document for Rechnung',
        parameters: {
          text: { title: 'Versicherungsperiode (Id)', type: 'string', required: true },
          text_1: { title: 'Buchung (Id)', type: 'string', required: true },
          text_2: { title: 'Versicherungsnehmer (Id)', type: 'string', required: true },
        },
      },
      CreateEmailDraft: {
        workflowId: '55f20771-cfd8-ef11-a730-002248a06e70',
        description: 'Creates email draft for Rechnung',
        parameters: {
          text: { title: 'Posten Im Inkasso (Id)', type: 'string', required: true },
          text_1: { title: 'Document Path', type: 'string', required: true },
        },
      },
    };
  }
}
```

## Example 10: Approval Workflow

```typescript
async run(ctx: FlowContext) {
  await ctx.compose('BuildRequestSummary', {
    title: ctx.triggerBody()?.['title'],
    amount: ctx.triggerBody()?.['amount'],
    requestedBy: ctx.triggerBody()?.['email']
  });

  await ctx.connectorWebhook('WaitForManagerApproval', {
    connector: 'approvals',
    operation: 'StartAndWaitForAnApproval',
    params: {
      approvalType: 'Basic',
      title: ctx.eval(`Approve: @{triggerBody()?['title']}`),
      assignedTo: ctx.parameters('ApproverEmail'),
      details: ctx.eval(`Amount: $@{triggerBody()?['amount']}`)
    },
    connectionReferenceName: 'shared_approvals'
  });

  /** @action CheckApprovalOutcome @type if */
  if (ctx.body('WaitForManagerApproval')?.['outcome'] === 'Approve') {
    await ctx.connectors.office365.SendEmailV2('SendApprovalConfirmation', {
      'emailMessage/To': ctx.triggerBody()?.['email'],
      'emailMessage/Subject': 'Request Approved',
      'emailMessage/Body': '<p>Your request has been approved.</p>'
    }, 'shared_office365');
  } else {
    await ctx.connectors.office365.SendEmailV2('SendRejectionNotice', {
      'emailMessage/To': ctx.triggerBody()?.['email'],
      'emailMessage/Subject': 'Request Rejected',
      'emailMessage/Body': '<p>Your request was not approved.</p>'
    }, 'shared_office365');
  }
}
```

## Example 11: Flatten + Distinct Without Foreach (Performance)

When you need to extract a property (e.g., emails) from a nested array and dedupe it, the obvious approach is a nested `foreach` + `Initialize variable` + `AppendToArrayVariable`. Power Automate pays significant per-iteration scheduling overhead even when the loop body has no I/O — for ~10 rows × ~3 nested items this commonly costs 2–4 seconds of wall time before the first downstream action even starts.

This entire pattern collapses to **a single Compose action** using `xpath` to flatten and `union` to dedupe.

### The slow shape

```typescript
// ❌ SLOW — nested foreach + AppendToArrayVariable, ~3s for ~30 items even with no I/O
/** @action Initialize_userEmails */
let userEmails: string[] = [];

/** @action ProcessRows @type foreach */
for (const row of (ctx.outputs('PermissionRows') ?? [])) {
  /** @action ProcessUsers @type foreach */
  for (const user of (row?.['Permissions'] ?? [])) {
    /** @action Append_email */
    userEmails.push(user?.['Email']);
  }
}
// userEmails now contains duplicates — needs a separate dedupe step too
```

### The fast shape

```typescript
// ✅ FAST — single expression-based Compose, runs in milliseconds
await ctx.compose('DistinctUserEmails', ctx.eval(
  "@union(xpath(xml(json(concat('{\"r\":{\"i\":', string(outputs('PermissionRows')), '}}'))), '//Email/text()'), json('[]'))"
));

// Downstream consumers read it as a normal array
/** @action GrantPermissions @type foreach @runtimeConfig {"concurrency":{"repetitions":20}} */
for (const email of (ctx.outputs('DistinctUserEmails') ?? [])) {
  // ...
}

await ctx.compose('Recipients', ctx.outputs('DistinctUserEmails').join(';'));
```

### How the expression works

1. `string(outputs('PermissionRows'))` — serialise the array to JSON text
2. `concat('{"r":{"i":', ..., '}}')` — wrap in a single-root object so `xml()` accepts it
3. `xml(json(...))` — convert to XML; each row becomes an `<i>` element with nested `<Permissions><Email>…</Email></Permissions>` children
4. `xpath(..., '//Email/text()')` — pull every `Email` text node across all rows in one shot, returning a flat string array
5. `union(arr, json('[]'))` — return the **distinct** elements of `arr` (the standard Power Automate dedupe trick)

### `createArray()` vs `json('[]')` for empty arrays — important gotcha

`union(arr, [])` is the canonical dedupe idiom, but Power Automate has no array-literal syntax inside expressions. Two things you might reach for:

```typescript
// ❌ FAILS at runtime: "createArray expects a comma separated list of parameters.
//                      The function was invoked with no parameters."
ctx.eval("@union(someArray, createArray())")

// ✅ WORKS: json('[]') parses an empty JSON array literal — the standard idiom
ctx.eval("@union(someArray, json('[]'))")
```

`createArray()` requires **at least one argument** in Power Automate. Always use `json('[]')` for an empty-array literal in expressions.

### Other performance levers used together

This pattern composes naturally with the other two big wins:
- **Parallel `foreach` iterations** via `@runtimeConfig {"concurrency":{"repetitions":N}}` for the loop that consumes the deduplicated list (see [DSL Syntax → For Each Loop](dsl-syntax.md#parallel-iterations-runtimeconfig))
- **Parallel branches** for upstream queries that build the source array, via `@runAfter <commonPredecessor>: Succeeded` (see [DSL Syntax → Parallel branches](dsl-syntax.md#parallel-branches-fan-out-via-runafter))

Combined, these three patterns routinely cut flow runtime by 50–70% with no behavioural change.
