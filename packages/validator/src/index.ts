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
          const need = (keys: string[]) => keys.filter((k) => p[k] === undefined);
          if (op === 'getitems') {
            const miss = need(['siteId','listId']); if (miss.length) issues.push({ level: 'error', code: 'SP_PARAMS', message: `SharePoint ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'getitembyid') {
            const miss = need(['siteId','listId','itemId']); if (miss.length) issues.push({ level: 'error', code: 'SP_PARAMS', message: `SharePoint ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'createitem') {
            const miss = need(['siteId','listId','fields']); if (miss.length) issues.push({ level: 'error', code: 'SP_PARAMS', message: `SharePoint ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'updateitem') {
            const miss = need(['siteId','listId','itemId','fields']); if (miss.length) issues.push({ level: 'error', code: 'SP_PARAMS', message: `SharePoint ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'deleteitem') {
            const miss = need(['siteId','listId','itemId']); if (miss.length) issues.push({ level: 'error', code: 'SP_PARAMS', message: `SharePoint ${n.name} missing: ${miss.join(', ')}` });
          }
        } else if (c.connector === 'dataverse') {
          const op = String(c.operation).toLowerCase();
          const p = c.params || {};
          const need = (keys: string[]) => keys.filter((k) => p[k] === undefined);
          if (op === 'listrows') {
            const miss = need(['entitySetName']); if (miss.length) issues.push({ level: 'error', code: 'DV_PARAMS', message: `Dataverse ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'createrow') {
            const miss = need(['entitySetName','body']); if (miss.length) issues.push({ level: 'error', code: 'DV_PARAMS', message: `Dataverse ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'updaterow') {
            const miss = need(['entitySetName','id','body']); if (miss.length) issues.push({ level: 'error', code: 'DV_PARAMS', message: `Dataverse ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'deleterow') {
            const miss = need(['entitySetName','id']); if (miss.length) issues.push({ level: 'error', code: 'DV_PARAMS', message: `Dataverse ${n.name} missing: ${miss.join(', ')}` });
          } else if (op === 'retrieverow') {
            const miss = need(['entitySetName','id']); if (miss.length) issues.push({ level: 'error', code: 'DV_PARAMS', message: `Dataverse ${n.name} missing: ${miss.join(', ')}` });
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
