import type { FlowIR, Node } from '@flowforger/ir';
import { DESCRIPTION_OVERFLOW_METADATA_KEY } from '@flowforger/ir';
import { collectExpressionIssues } from './expressions.js';
import { collectIrPlacementIssues, collectLogicAppsPlacementIssues } from './placement.js';
import { collectIrStructureIssues, collectLogicAppsStructureIssues } from './structure.js';

export { MAX_ACTION_NESTING_DEPTH } from './placement.js';
export { LIMITS, parseIsoDurationMs } from './structure.js';

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

/**
 * Descriptions (action/trigger notes, the flow description) are plain text to FlowForger, but
 * Power Automate runs them through the same template parser as every other string in the
 * definition: "@{...}" anywhere is an interpolation and a leading "@" starts an expression.
 * Either makes the cloud reject the flow on save (InvalidTemplate). In the DSL, descriptions
 * come from comments — see DSL035/DSL036 in @flowforger/dsl-language-service.
 */
function collectDescriptionIssues(description: unknown, path: string, what: string): ValidationIssue[] {
  if (typeof description !== 'string') return [];
  const issues: ValidationIssue[] = [];
  const interpolation = description.match(/@\{[^}\n]*\}?/);
  if (interpolation) {
    issues.push({
      level: 'error',
      code: 'DESCRIPTION_EXPRESSION',
      message: `${what} contains '${interpolation[0]}'. Power Automate parses "@{...}" in a description as a template expression and rejects the flow on save. Remove the "@".`,
      path,
    });
  }
  if (/^\s*@(?!@)/.test(description)) {
    issues.push({
      level: 'warning',
      code: 'DESCRIPTION_LEADING_AT',
      message: `${what} starts with "@". Power Automate parses a description that begins with "@" as a template expression. Start it with a word instead.`,
      path,
    });
  }
  return issues;
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
  const triggers = ir.nodes.filter((n) => n.type === 'trigger' || n.type === 'recurrence');
  if (triggers.length !== 1) {
    issues.push({ level: 'error', code: 'IR_TRIGGER', message: 'Flow must have exactly one trigger' });
  }
  const actions = ir.nodes.filter((n) => n.type === 'action');
  // Connector / control nodes are actions too — only a trigger-only flow is empty
  const executable = ir.nodes.filter((n) => n.type !== 'trigger' && n.type !== 'recurrence');
  if (executable.length === 0) {
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

  issues.push(...collectDescriptionIssues(ir.description, 'description', 'Flow description'));

  // control constructs
  function walk(nodes: Node[], isNested = false) {
    for (const n of nodes) {
      issues.push(...collectDescriptionIssues((n as any).description, `nodes.${n.name}.description`, `Description of ${n.type} '${n.name}'`));
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

  // Placement rules the cloud enforces on save: Response/Terminate not inside loops, Response
  // needs a request trigger and no parallel branch, nesting depth ≤ 8
  issues.push(...collectIrPlacementIssues(ir));

  // Structural rules and definition limits: duplicate/long names, counts, runAfter integrity,
  // until/terminate/retry/recurrence shapes, expression references to actions/loops/parameters
  issues.push(...collectIrStructureIssues(ir));

  // Expression syntax + unknown-function checks across every node value
  issues.push(...collectExpressionIssues(ir.nodes, 'nodes'));

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

  // Descriptions (notes) anywhere in the definition tree
  issues.push(...collectDescriptionIssues(definition.description, 'definition.description', 'Flow description'));
  for (const triggerName of triggerKeys) {
    const trigger = definition.triggers[triggerName];
    if (trigger && typeof trigger === 'object') {
      issues.push(...collectLogicAppsNodeDescriptionIssues(trigger, `definition.triggers.${triggerName}`, `Description of trigger "${triggerName}"`));
    }
  }
  walkLogicAppsActions(definition.actions, 'definition.actions', issues);

  // Placement rules the cloud enforces on save: Response/Terminate not inside loops, Response
  // needs a request trigger and no parallel branch, InitializeVariable at root, nesting depth ≤ 8
  issues.push(...collectLogicAppsPlacementIssues(definition));

  // Structural rules and definition limits (see structure.ts); `def` carries connectionReferences
  issues.push(...collectLogicAppsStructureIssues(def, definition));

  // Expression syntax + unknown-function checks across the whole definition
  issues.push(...collectExpressionIssues(definition, 'definition'));

  return { ok: issues.find((i) => i.level === 'error') === undefined, issues };
}

function collectLogicAppsNodeDescriptionIssues(node: any, path: string, what: string): ValidationIssue[] {
  const issues = collectDescriptionIssues(node.description, `${path}.description`, what);
  // The emitter stores a >255-char description's full text in metadata; the cloud parses that too.
  const overflow = node.metadata?.[DESCRIPTION_OVERFLOW_METADATA_KEY];
  if (typeof overflow === 'string') {
    issues.push(...collectDescriptionIssues(overflow, `${path}.metadata.${DESCRIPTION_OVERFLOW_METADATA_KEY}`, `${what} (full text in metadata)`));
  }
  return issues;
}

/** Walk the actions tree (scope/if/foreach/until/switch nesting) and check every action's description. */
function walkLogicAppsActions(actions: any, path: string, issues: ValidationIssue[]): void {
  if (!actions || typeof actions !== 'object') return;
  for (const [name, action] of Object.entries<any>(actions)) {
    if (!action || typeof action !== 'object') continue;
    const actionPath = `${path}.${name}`;
    issues.push(...collectLogicAppsNodeDescriptionIssues(action, actionPath, `Description of action "${name}"`));
    walkLogicAppsActions(action.actions, `${actionPath}.actions`, issues);
    walkLogicAppsActions(action.else?.actions, `${actionPath}.else.actions`, issues);
    walkLogicAppsActions(action.default?.actions, `${actionPath}.default.actions`, issues);
    if (action.cases && typeof action.cases === 'object') {
      for (const [caseName, c] of Object.entries<any>(action.cases)) {
        walkLogicAppsActions(c?.actions, `${actionPath}.cases.${caseName}.actions`, issues);
      }
    }
  }
}
