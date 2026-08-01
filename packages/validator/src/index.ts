import type { FlowIR, Node } from '@flowforger/ir';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ValidationIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export function validateFlowIR(ir: FlowIR): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!ir.name || typeof ir.name !== 'string') {
    issues.push({ level: 'error', code: 'IR_NAME', message: 'Flow name is required' });
  }
  if (ir.workflowId !== undefined) {
    if (typeof ir.workflowId !== 'string') {
      issues.push({
        level: 'error',
        code: 'IR_WORKFLOW_ID',
        message: `workflowId must be a string (got: ${typeof ir.workflowId})`,
      });
    } else if (!GUID_PATTERN.test(ir.workflowId)) {
      issues.push({
        level: 'error',
        code: 'IR_WORKFLOW_ID',
        message: `workflowId must be a GUID (got: '${ir.workflowId}')`,
      });
    }
  }
  const triggers = ir.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) {
    issues.push({ level: 'error', code: 'IR_TRIGGER', message: 'Flow must have exactly one trigger' });
  }
  const actions = ir.nodes.filter((n) => n.type === 'action');
  if (actions.length === 0) {
    issues.push({ level: 'warning', code: 'IR_ACTIONS', message: 'Flow has no actions' });
  }
  for (const a of actions) {
    // @ts-ignore
    if (a.kind === 'http' && (!a.inputs.method || !a.inputs.url)) {
      issues.push({ level: 'error', code: 'IR_HTTP', message: `HTTP action ${a.name} missing method or url` });
    }
    // @ts-ignore
    if (a.kind === 'http' && !a.retryPolicy) {
      issues.push({ level: 'info', code: 'HTTP_RETRY', message: `HTTP action ${a.name} has no retryPolicy` });
    }
  }
  // Track initializevariable actions by variableName to detect duplicates across the whole IR.
  // PA rejects two InitializeVariable actions targeting the same variable name on import.
  const initVarNames = new Map<string, string[]>(); // variableName -> [actionName, actionName, ...]

  // control constructs
  function walk(nodes: Node[], isNested = false) {
    for (const n of nodes) {
      // Check for initializevariable inside nested structures (not allowed in Logic Apps)
      if (n.type === 'action' && (n as any).kind === 'initializevariable' && isNested) {
        issues.push({
          level: 'error',
          code: 'VAR_INIT_NESTED',
          message: `Variable initialization '${n.name}' cannot be inside a control structure (if, scope, foreach, switch, dountil). Move it to the root level.`
        });
      }

      // Collect initializevariable variableNames to flag duplicates later
      if (n.type === 'action' && (n as any).kind === 'initializevariable') {
        const varName = (n as any).inputs?.variableName;
        if (typeof varName === 'string' && varName.length > 0) {
          const existing = initVarNames.get(varName) || [];
          existing.push(n.name);
          initVarNames.set(varName, existing);
        }
      }

      if (n.type === 'if') {
        // @ts-ignore
        if (!n.condition) issues.push({ level: 'error', code: 'IF_CONDITION', message: `If ${n.name} missing condition` });
        walk((n as any).actions || [], true);
        walk((n as any).elseActions || [], true);
      } else if (n.type === 'scope') {
        walk((n as any).actions || [], true);
      } else if (n.type === 'foreach') {
        // @ts-ignore
        if (!n.itemsExpression) issues.push({ level: 'error', code: 'FOREACH_ITEMS', message: `Foreach ${n.name} missing itemsExpression` });
        walk((n as any).actions || [], true);
      } else if (n.type === 'switch') {
        // Walk switch cases
        const switchNode = n as any;
        for (const c of switchNode.cases || []) {
          walk(c.actions || [], true);
        }
        walk(switchNode.defaultActions || [], true);
      } else if (n.type === 'dountil') {
        walk((n as any).actions || [], true);
      }
      // Connector validation (basic param checks)
      // @ts-ignore
      if (n.type === 'connector') {
        // @ts-ignore
        const c = n as any;
        if (!c.connector || !c.operation) {
          issues.push({ level: 'error', code: 'CONNECTOR_FIELDS', message: `Connector ${n.name} missing connector or operation` });
        } else if (c.connector === 'sharepoint') {
          const op = String(c.operation).toLowerCase();
          const p = c.params || {};
          // Accept any spelling of a required concept; error only if none is present.
          // Alternatives are backed by evidence (see task-10-report.md): the emitter's
          // SP_COMMON_PARAM_ALIASES/SP_PARAM_ALIASES (packages/emitter-logicapps/src/index.ts),
          // the SharePoint connector's normalizeInputs/extractItemFields
          // (packages/connectors-sharepoint/src/index.ts), real tenant flows under
          // tmp/*/logicapps.json, and examples/sharepoint/README.md's "Power Automate Format".
          const hasAny = (keys: string[]) => keys.some((k) => p[k] !== undefined);
          const hasItemPrefixed = () => Object.keys(p).some((k) => k.startsWith('item/'));
          const SITE = { label: 'siteId (dataset)', present: () => hasAny(['siteId', 'dataset', 'siteUrl']) };
          const LIST = { label: 'listId (table)', present: () => hasAny(['listId', 'table']) };
          const ITEM_ID = { label: 'itemId (id)', present: () => hasAny(['itemId', 'id']) };
          // Power Automate flattens the fields payload to item/<FieldName> keys rather
          // than a fields object (see denormalizeSpParams and tmp/7/logicapps.json).
          const FIELDS = { label: 'fields (item/*)', present: () => hasAny(['fields', 'item']) || hasItemPrefixed() };
          const missingConcepts = (concepts: Array<{ label: string; present: () => boolean }>) =>
            concepts.filter((concept) => !concept.present()).map((concept) => concept.label);
          if (op === 'getitems') {
            const miss = missingConcepts([SITE, LIST]); if (miss.length) issues.push({ level: 'error', code: 'SP_PARAMS', message: `SharePoint ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'getitembyid') {
            const miss = missingConcepts([SITE, LIST, ITEM_ID]); if (miss.length) issues.push({ level: 'error', code: 'SP_PARAMS', message: `SharePoint ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'createitem') {
            const miss = missingConcepts([SITE, LIST, FIELDS]); if (miss.length) issues.push({ level: 'error', code: 'SP_PARAMS', message: `SharePoint ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'updateitem') {
            const miss = missingConcepts([SITE, LIST, ITEM_ID, FIELDS]); if (miss.length) issues.push({ level: 'error', code: 'SP_PARAMS', message: `SharePoint ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'deleteitem') {
            const miss = missingConcepts([SITE, LIST, ITEM_ID]); if (miss.length) issues.push({ level: 'error', code: 'SP_PARAMS', message: `SharePoint ${n.name} missing: ${miss.join(', ')}` });
          }
        } else if (c.connector === 'dataverse') {
          const op = String(c.operation).toLowerCase();
          const p = c.params || {};
          // Accept any spelling of a required concept; error only if none is present.
          // Alternatives are backed by evidence (see task-10-report.md):
          // packages/connectors-dataverse/src/index.ts's getEntityAndId/getBody (both
          // 'entityName'/'entitySetName' and 'recordId'/'id' are read at runtime; the
          // body is read from either a 'body' object or flattened 'item/*' keys), and
          // real tenant flows under tmp/*/logicapps.json which consistently use
          // entityName + recordId + flattened item/* payloads.
          const hasAny = (keys: string[]) => keys.some((k) => p[k] !== undefined);
          const hasItemPrefixed = () => Object.keys(p).some((k) => k.startsWith('item/'));
          const ENTITY = { label: 'entitySetName (entityName)', present: () => hasAny(['entitySetName', 'entityName']) };
          const RECORD_ID = { label: 'id (recordId)', present: () => hasAny(['id', 'recordId']) };
          const BODY = { label: 'body (item/*)', present: () => hasAny(['body', 'item']) || hasItemPrefixed() };
          const missingConcepts = (concepts: Array<{ label: string; present: () => boolean }>) =>
            concepts.filter((concept) => !concept.present()).map((concept) => concept.label);
          if (op === 'listrows') {
            const miss = missingConcepts([ENTITY]); if (miss.length) issues.push({ level: 'error', code: 'DV_PARAMS', message: `Dataverse ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'createrow') {
            const miss = missingConcepts([ENTITY, BODY]); if (miss.length) issues.push({ level: 'error', code: 'DV_PARAMS', message: `Dataverse ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'updaterow') {
            const miss = missingConcepts([ENTITY, RECORD_ID, BODY]); if (miss.length) issues.push({ level: 'error', code: 'DV_PARAMS', message: `Dataverse ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'deleterow') {
            const miss = missingConcepts([ENTITY, RECORD_ID]); if (miss.length) issues.push({ level: 'error', code: 'DV_PARAMS', message: `Dataverse ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'retrieverow') {
            const miss = missingConcepts([ENTITY, RECORD_ID]); if (miss.length) issues.push({ level: 'error', code: 'DV_PARAMS', message: `Dataverse ${n.name} missing: ${miss.join(', ')}` });
          }
        }
      }
      // Connector webhook validation (basic param checks)
      // @ts-ignore
      if (n.type === 'connectorwebhook') {
        // @ts-ignore
        const c = n as any;
        if (!c.connector || !c.operation) {
          issues.push({ level: 'error', code: 'CONNECTOR_WEBHOOK_FIELDS', message: `Webhook connector ${n.name} missing connector or operation` });
        } else if (c.connector === 'approvals') {
          const op = String(c.operation).toLowerCase();
          const p = c.params || {};
          if (op === 'startandwaitforanapproval') {
            if (!p.approvalType) {
              issues.push({ level: 'error', code: 'APPROVAL_PARAMS', message: `Approval ${n.name} missing approvalType` });
            }
          }
        }
      }
    }
  }
  walk(ir.nodes as any);

  // Report duplicate InitializeVariable variable names
  for (const [varName, actionNames] of initVarNames) {
    if (actionNames.length > 1) {
      issues.push({
        level: 'error',
        code: 'VAR_INIT_DUPLICATE',
        message: `Variable '${varName}' is initialized more than once (actions: ${actionNames.join(', ')}). Power Automate requires a single InitializeVariable per variable name.`,
      });
    }
  }

  return { ok: issues.find((i) => i.level === 'error') === undefined, issues };
}

export function validateLogicApps(def: any): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Check if def is an object
  if (!def || typeof def !== 'object') {
    return { ok: false, issues: [{ level: 'error', code: 'DEF_TYPE', message: 'Definition must be an object' }] };
  }

  // Support both formats:
  // 1. Logic Apps clientdata format: { definition: { ... } }
  // 2. Dataverse flow format: { properties: { definition: { ... } } }
  let definition = def.definition;

  if (!definition && def.properties && def.properties.definition) {
    // Use Dataverse format
    definition = def.properties.definition;
  }

  // Check if definition property exists
  if (!definition) {
    issues.push({ level: 'error', code: 'DEF_MISSING', message: 'Missing "definition" property (expected at root level or under "properties")' });
    return { ok: false, issues };
  }

  // Check if definition is an object
  if (typeof definition !== 'object') {
    issues.push({ level: 'error', code: 'DEF_TYPE', message: 'The "definition" property must be an object' });
    return { ok: false, issues };
  }

  // Check if triggers property exists in definition
  if (!definition.triggers) {
    issues.push({ level: 'error', code: 'DEF_TRIGGER', message: 'Missing "triggers" property in definition' });
    return { ok: false, issues };
  }

  // Check if triggers is an object
  if (typeof definition.triggers !== 'object') {
    issues.push({ level: 'error', code: 'DEF_TRIGGER_TYPE', message: 'The "triggers" property must be an object' });
    return { ok: false, issues };
  }

  // Check that there's at least one trigger defined
  const triggerKeys = Object.keys(definition.triggers);
  if (triggerKeys.length === 0) {
    issues.push({ level: 'error', code: 'DEF_TRIGGER_EMPTY', message: 'The "triggers" object is empty - at least one trigger is required' });
  }

  // Validate each trigger has required fields
  for (const triggerName of triggerKeys) {
    const trigger = definition.triggers[triggerName];
    if (!trigger || typeof trigger !== 'object') {
      issues.push({ level: 'error', code: 'TRIGGER_INVALID', message: `Trigger "${triggerName}" must be an object`, path: `definition.triggers.${triggerName}` });
      continue;
    }
    if (!trigger.type) {
      issues.push({ level: 'warning', code: 'TRIGGER_TYPE', message: `Trigger "${triggerName}" is missing "type" property`, path: `definition.triggers.${triggerName}` });
    }
  }

  return { ok: issues.find((i) => i.level === 'error') === undefined, issues };
}
