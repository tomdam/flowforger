/**
 * CANONICAL EXAMPLE — a single, complete .ff.ts that exercises every part of the
 * recognized subset (flowforger-dsl.ebnf) and demonstrates every conformance rule
 * (conformance.md). It is intentionally over-built: a real flow would use a subset.
 *
 * This file is DOCUMENTATION. It is not wired into a build. Read it top-to-bottom
 * alongside the grammar — each block is annotated with the production it matches
 * (`grammar:`) and the conformance rule it satisfies (`rule:`).
 *
 * Reading order for a newcomer (human or AI agent):
 *   1. conformance.md   — the 14 rules that make a flow valid (read this FIRST).
 *   2. this file        — see the rules applied in one coherent flow.
 *   3. flowforger-dsl.ebnf / jsdoc-tags.ebnf — the precise productions, when you
 *      need to know exactly what form a construct may take.
 *
 * NOTE: there is deliberately NO `import` line. A .ff.ts file is not compiled by
 * tsc; the transformer resolves @Flow / @HttpTrigger / @Action / FlowContext from
 * its own symbol table. An import statement is dead weight (grammar: flow_file).
 *
 * The flow below: receives an order over HTTP, validates it, fetches matching
 * SharePoint records, processes each line item, branches on order type, polls an
 * external status, and responds — with a try/catch/finally around the risky call.
 */

// File-level JSDoc above the class becomes the flow description (<= 256 chars, rule R9).
/**
 * Validate an incoming order, enrich it from SharePoint, process each line item,
 * and respond with the result. Demonstrates the full recognized subset.
 */
@Flow('CanonicalOrderFlow')
class CanonicalOrderFlow {
  // grammar: trigger_member / trigger_decorator. Exactly one trigger (rule R11).
  // Alternatives: @ManualTrigger (see rule R13 for the x-ms-dynamically-added
  // requirement on inputs), @RecurrenceTrigger({...}), @ConnectorTrigger({...}).
  @HttpTrigger({ method: 'POST' })
  trigger() {
    return {
      schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          type: { type: 'string' },
          lineItems: { type: 'array' },
        },
      },
    };
  }

  // grammar: action_member. Exactly one @Action method, conventionally `run` (rule R11).
  @Action()
  async run(ctx: FlowContext) {
    // ---- Variables (grammar: variable_decl_stmt) ----------------------------
    // A `let`/`const` whose initializer is NOT `await <action_call>` becomes an
    // InitializeVariable. @action is OPTIONAL: with no JSDoc the transformer
    // auto-names it `Initialize_<varName>`. Add @action only to override that
    // default — but a descriptive, unique name is recommended (rule R4).
    let processedCount: number = 0;          // auto-named "Initialize_processedCount"

    /** @action Build_sku_list */            // explicit @action overrides the default name
    let skuList: string[] = [];

    // ---- Early validation + terminate (rule R5: never `return`) --------------
    // grammar: if_stmt. An `if` is recognized structurally (by its TypeScript kind),
    // so @type and @action are BOTH optional here — but recommended: @type documents
    // intent, and @action gives a stable, unique, descriptive name (the auto-name
    // for an un-annotated if is generic, e.g. "Condition", and collides easily).
    // Compound conditions use && / || — NOT ctx.and()/ctx.or() (rule R7).
    /** @action Validate_order @type if */
    if (ctx.empty(ctx.triggerBody()?.['orderId']) || ctx.empty(ctx.triggerBody()?.['lineItems'])) {
      // 'Failed' may carry { code, message }; 'Succeeded'/'Cancelled' must NOT (rule R5).
      await ctx.terminate('Reject_invalid_order', 'Failed', {
        code: 'INVALID_ORDER',
        message: 'orderId and lineItems are required',
      });
    }

    // ---- Compose: read its result with ctx.outputs() (rule R12) --------------
    // Action calls take their name as the FIRST argument — no @action JSDoc (rule R4).
    // Short leading comment is allowed; it becomes the description (<= 256 chars, R9).
    // Normalize the order payload for downstream steps.
    await ctx.compose('Normalize_order', {
      id: ctx.triggerBody()?.['orderId'],
      type: ctx.triggerBody()?.['type'],
    });

    // ---- Connector call: read its result with ctx.body() (rule R12) ----------
    // grammar: connector_action. The connection-reference name is declared in the
    // constructor. Parameter keys are connector-specific (see connectors.md).
    await ctx.connectors.sharepoint.GetItems('Get_matching_records', {
      // Externalize constants as parameters — never top-level const (rule R2).
      // The key passed to ctx.parameters() must match the constructor key EXACTLY (rule R3).
      dataset: ctx.parameters('Site URL (cr_SiteUrl)'),
      table: ctx.parameters('Orders List (cr_OrdersListId)'),
      '$filter': ctx.eval(`OrderId eq '@{triggerBody()?['orderId']}'`),
    }, 'shared_sharepointonline');

    // ---- Foreach over a connector body, with array append (rules R8, R12) ----
    // grammar: foreach_stmt. ctx.body('Get_matching_records')?['value'] is the
    // connector's result collection.
    /** @action For_each_line_item @type foreach */
    for (const item of ctx.body('Get_matching_records')?.['value'] ?? []) {
      // Append to an array variable with .push() ONLY — never spread/concat (rule R8).
      // ctx.items('<loopName>') is the current iteration element. NOTE: .push() is
      // ALWAYS auto-named `Append_<varName>` (here "Append_skuList") — an @action
      // comment on a push is ignored by the transformer.
      skuList.push(ctx.items('For_each_line_item')?.['Sku']);

      // Increment a numeric variable (grammar: increment_variable). Auto-named
      // "Increment_processedCount"; @action would override it (honored for +=).
      processedCount += 1;
    }

    // ---- Switch: action names must be unique ACROSS cases (rule R1) ----------
    // grammar: switch_stmt / case_clause. Each case is its own scope, but output
    // references after the switch are ambiguous if names collide — so suffix names.
    // (`break;` is idiomatic TS and accepted, but has no Logic Apps equivalent and is
    //  ignored by the compiler — cases never fall through in the lowered flow.)
    /** @action Route_by_type @type switch */
    switch (ctx.outputs('Normalize_order')?.['type']) {
      /** @action Case_express @type case */
      case 'express':
        await ctx.compose('Set_priority_express', { priority: 1 });
        break;
      /** @action Case_standard @type case */
      case 'standard':
        await ctx.compose('Set_priority_standard', { priority: 5 });
        break;
      default:
        await ctx.compose('Set_priority_default', { priority: 9 });
    }

    // ---- Array merge: NO @{...} wrapping (rule R10) --------------------------
    // ctx.union(...) emits @union(...) which PRESERVES the array type. Wrapping it
    // in ctx.braced() / @{...} would stringify it and break any downstream array use.
    await ctx.compose('All_skus', ctx.union(skuList, ctx.outputs('Normalize_order')?.['extraSkus'] ?? []));

    // ---- Try / Catch / Finally (rule R6) ------------------------------------
    // Scope is the ONE control construct where @type is REQUIRED: a bare { } block
    // becomes a ScopeNode only with `@type scope` — without it the block is flattened
    // and its actions are inlined (unlike if/foreach/switch/until, which are
    // recognized structurally). @action is still optional (auto-named "Scope").
    //
    // The transformer auto-chains each action runAfter the previous one. A catch
    // scope only runs on Failure, so WITHOUT a Finally, every action after it is
    // skipped on the success path. The Finally scope runs on all outcomes, making
    // auto-chaining safe again.
    /** @action TryBlock @type scope */
    {
      await ctx.http('Notify_fulfillment', {
        method: 'POST',
        url: 'https://api.example.com/fulfillment',
        body: { skus: ctx.outputs('All_skus'), count: ctx.variables('processedCount') },
      });
    }

    /** @action CatchBlock @type scope @runAfter TryBlock: Failed */
    {
      await ctx.compose('Record_failure', { failed: true });
    }

    /** @action FinallyBlock @type scope @runAfter TryBlock: Succeeded, Failed, Skipped */
    {
      await ctx.compose('Cleanup', { done: true });
    }

    // ---- Do-Until poll (grammar: dountil_stmt) ------------------------------
    // @limit caps iterations (jsdoc-tags.ebnf). Safe to auto-chain after FinallyBlock.
    /** @action Poll_status @type until @limit {"count":10,"timeout":"PT5M"} */
    do {
      await ctx.http('Check_status', { method: 'GET', url: 'https://api.example.com/status' });
    } while (ctx.body('Check_status')?.['state'] !== 'complete');

    // ---- Respond (grammar: builtin_action `response`) -----------------------
    // For PowerApp/VirtualAgent responses, pass schema as the 5th arg and
    // 'PowerApp'/'VirtualAgent' as the 6th — every schema property needs
    // "x-ms-dynamically-added": true (rule R14).
    await ctx.response('Respond', 200, {
      processed: ctx.variables('processedCount'),
      skus: ctx.outputs('All_skus'),
    });
  }

  // grammar: constructor_member. Conventionally LAST. Only `ctx.flow.<key> = ...`
  // assignments are recognized (flow_config_key).
  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      $schema:
        'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      schemaVersion: '1.0.0.0',
    };

    // Required when the flow uses connectors.
    ctx.flow.connectionReferences = {
      shared_sharepointonline: {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
        connectionReferenceLogicalName: 'cr_sharepoint',
      },
    };

    // Parameters externalize constants (rule R2). The KEY string is what
    // ctx.parameters() must pass verbatim (rule R3).
    ctx.flow.parameters = {
      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },
      'Site URL (cr_SiteUrl)': {
        type: 'String',
        defaultValue: 'https://contoso.sharepoint.com/sites/Orders',
        metadata: { schemaName: 'cr_SiteUrl', description: 'SharePoint site URL' },
      },
      'Orders List (cr_OrdersListId)': {
        type: 'String',
        defaultValue: '00000000-0000-0000-0000-000000000000',
        metadata: { schemaName: 'cr_OrdersListId', description: 'Orders list GUID' },
      },
    };
  }
}
