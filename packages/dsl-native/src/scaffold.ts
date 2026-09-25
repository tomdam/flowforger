/**
 * Flow scaffolds — the starting DSL a "New flow" action puts in the editor.
 *
 * One builder for every surface that creates flows (web workspace, web local
 * folder, VS Code, CLI) so the trigger choices and the generated skeleton stay
 * in sync. Every scaffold compiles with `transformCode` as-is; the non-connector
 * ones also run locally without any tokens.
 */

/** Trigger kinds a new flow can start from. */
export type ScaffoldTriggerKind =
  | 'manual'
  | 'http'
  | 'recurrence'
  | 'sharepoint-item-created'
  | 'dataverse-row-added'
  | 'outlook-email-received'
  | 'teams-channel-message';

/** Power Automate's own "Create" grouping — makers already think in these terms. */
export type ScaffoldTriggerGroup = 'instant' | 'scheduled' | 'automated';

export interface ScaffoldTriggerOption {
  kind: ScaffoldTriggerKind;
  /** Short card title, e.g. "Manual button". */
  label: string;
  /** One-line hint shown under the label. */
  description: string;
  group: ScaffoldTriggerGroup;
  /** Connector the trigger needs a connection for; undefined for built-in triggers. */
  connector?: 'sharepoint' | 'dataverse' | 'office365' | 'teams';
}

/** Ordered list for a picker UI. Order within a group is the recommended display order. */
export const SCAFFOLD_TRIGGERS: readonly ScaffoldTriggerOption[] = [
  {
    kind: 'manual',
    label: 'Manual button',
    description: 'Run on demand from Power Automate, Power Apps, or the local runner.',
    group: 'instant',
  },
  {
    kind: 'http',
    label: 'HTTP request',
    description: 'Webhook endpoint that receives a JSON body and returns a response.',
    group: 'instant',
  },
  {
    kind: 'recurrence',
    label: 'Schedule',
    description: 'Runs on a recurrence, e.g. every day at 08:00.',
    group: 'scheduled',
  },
  {
    kind: 'sharepoint-item-created',
    label: 'SharePoint item created',
    description: 'Starts when a new item is added to a list.',
    group: 'automated',
    connector: 'sharepoint',
  },
  {
    kind: 'dataverse-row-added',
    label: 'Dataverse row added',
    description: 'Starts when a row is created in a table.',
    group: 'automated',
    connector: 'dataverse',
  },
  {
    kind: 'outlook-email-received',
    label: 'Outlook email received',
    description: 'Starts when a new email arrives in a mailbox folder.',
    group: 'automated',
    connector: 'office365',
  },
  {
    kind: 'teams-channel-message',
    label: 'Teams channel message',
    description: 'Starts when a message is posted to a Teams channel.',
    group: 'automated',
    connector: 'teams',
  },
];

export const SCAFFOLD_GROUP_LABELS: Record<ScaffoldTriggerGroup, string> = {
  instant: 'Instant',
  scheduled: 'Scheduled',
  automated: 'Automated',
};

export const DEFAULT_SCAFFOLD_TRIGGER: ScaffoldTriggerKind = 'manual';

export function isScaffoldTriggerKind(value: unknown): value is ScaffoldTriggerKind {
  return typeof value === 'string' && SCAFFOLD_TRIGGERS.some((t) => t.kind === value);
}

export interface FlowScaffoldOptions {
  /** Flow display name — goes into `@Flow({ name })`. */
  name: string;
  /** Trigger to start from; defaults to a manual button. */
  trigger?: ScaffoldTriggerKind;
  /** Class identifier; derived from `name` when omitted. */
  className?: string;
}

/**
 * Derive a valid TypeScript class identifier from a flow name:
 * "my sales-report 2" → "MySalesReport2". Falls back to "MyFlow" when nothing usable remains.
 */
export function toFlowClassName(name: string): string {
  const pascal = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
  if (!pascal) return 'MyFlow';
  return /^[0-9]/.test(pascal) ? `Flow${pascal}` : pascal;
}

/** Build the starting DSL for a new flow. */
export function buildFlowScaffold(options: FlowScaffoldOptions): string {
  const trigger = options.trigger ?? DEFAULT_SCAFFOLD_TRIGGER;
  const className = options.className ?? toFlowClassName(options.name);
  const flowName = JSON.stringify(options.name);
  const body = SCAFFOLD_BODIES[trigger];

  return `@Flow({ name: ${flowName} })
class ${className} {
${body}
}
`;
}

// ---------------------------------------------------------------------------
// Bodies: everything between the class braces. Two-space indented.
// ---------------------------------------------------------------------------

const STANDARD_PARAMETERS = `      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },`;

const SCAFFOLD_BODIES: Record<ScaffoldTriggerKind, string> = {
  manual: `  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    let greeting: string = '';

    greeting = 'Hello from FlowForger!';

    await ctx.compose('Result', ctx.variables('greeting'));
  }`,

  http: `  @HttpTrigger({ method: 'POST' })
  trigger() {
    // Optional JSON schema for the request body — enables typed dynamic content in the designer
    return {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    let greeting: string = '';

    greeting = \`Hello, \${ctx.triggerBody()?.['name']}!\`;

    await ctx.response('Response', 200, { message: ctx.variables('greeting') });
  }`,

  recurrence: `  @RecurrenceTrigger({
    frequency: 'Day',
    interval: 1,
    timeZone: 'UTC',
    schedule: { hours: [8], minutes: [0] },
  })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    let runStartedAt: string = '';

    runStartedAt = ctx.utcNow();

    await ctx.compose('Result', {
      message: 'Scheduled run',
      startedAt: ctx.variables('runStartedAt'),
    });
  }`,

  'sharepoint-item-created': `  @ConnectorTrigger()
  trigger(ctx: FlowContext) {
    return {
      connector: 'sharepoint',
      operation: 'GetOnNewItems',
      params: {
        dataset: ctx.parameters('Site URL (cr_SiteUrl)'),
        table: ctx.parameters('List ID (cr_ListId)'),
      },
      connectionReferenceName: 'shared_sharepointonline',
      splitOn: "@triggerOutputs()?['body/value']",
      recurrence: { interval: 1, frequency: 'Minute' },
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    // The trigger body is the new list item; columns are addressed by internal name
    await ctx.compose('NewItem', {
      id: ctx.triggerBody()?.['ID'],
      title: ctx.triggerBody()?.['Title'],
    });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.connectionReferences = {
      shared_sharepointonline: {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      },
    };
    ctx.flow.parameters = {
${STANDARD_PARAMETERS}
      // The key is what you pass to ctx.parameters() — it must match exactly
      'Site URL (cr_SiteUrl)': {
        type: 'String',
        defaultValue: 'https://contoso.sharepoint.com/sites/MySite',
        metadata: { schemaName: 'cr_SiteUrl', description: 'SharePoint site URL' },
      },
      'List ID (cr_ListId)': {
        type: 'String',
        defaultValue: '00000000-0000-0000-0000-000000000000',
        metadata: { schemaName: 'cr_ListId', description: 'SharePoint list GUID' },
      },
    };
  }`,

  'dataverse-row-added': `  @ConnectorTrigger()
  trigger(ctx: FlowContext) {
    return {
      connector: 'dataverse',
      operation: 'SubscribeWebhookTrigger',
      params: {
        'subscriptionRequest/message': DataverseMessage.Added,
        'subscriptionRequest/entityname': 'account',
        'subscriptionRequest/scope': DataverseScope.Organization,
      },
      connectionReferenceName: 'shared_commondataserviceforapps',
      triggerType: 'OpenApiConnectionWebhook',
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    // The trigger body is the new row; columns are addressed by logical name
    await ctx.compose('NewRow', {
      id: ctx.triggerBody()?.['accountid'],
      name: ctx.triggerBody()?.['name'],
    });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.connectionReferences = {
      shared_commondataserviceforapps: {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
      },
    };
    ctx.flow.parameters = {
${STANDARD_PARAMETERS}
    };
  }`,

  'outlook-email-received': `  @ConnectorTrigger()
  trigger(ctx: FlowContext) {
    return {
      connector: 'office365',
      operation: 'OnNewEmailV3',
      params: {
        folderPath: 'Inbox',
        importance: 'Any',
        fetchOnlyWithAttachment: false,
        includeAttachments: false,
      },
      connectionReferenceName: 'shared_office365',
      splitOn: "@triggerOutputs()?['body/value']",
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('NewEmail', {
      from: ctx.triggerBody()?.['from'],
      subject: ctx.triggerBody()?.['subject'],
    });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.connectionReferences = {
      shared_office365: {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_office365',
      },
    };
    ctx.flow.parameters = {
${STANDARD_PARAMETERS}
    };
  }`,

  'teams-channel-message': `  @ConnectorTrigger()
  trigger(ctx: FlowContext) {
    return {
      connector: 'teams',
      operation: 'OnNewChannelMessage',
      params: {
        // TODO: replace with the team (group) ID and channel ID to watch
        groupId: '00000000-0000-0000-0000-000000000000',
        channelId: '19:00000000000000000000000000000000@thread.tacv2',
      },
      connectionReferenceName: 'shared_teams',
      splitOn: "@triggerOutputs()?['body/value']",
    };
  }

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('NewMessage', {
      from: ctx.triggerBody()?.['from']?.['user']?.['displayName'],
      text: ctx.triggerBody()?.['body']?.['content'],
    });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.connectionReferences = {
      shared_teams: {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_teams',
      },
    };
    ctx.flow.parameters = {
${STANDARD_PARAMETERS}
    };
  }`,
};
