/**
 * Connector Trigger Catalog
 *
 * Defines available trigger operations for each connector.
 * Separate from action metadata (metadata.ts) since triggers
 * have different characteristics (polling vs webhook, splitOn, etc.).
 */

import type { ParameterMetadata } from './metadata.js';
import { param } from './metadata.js';

/**
 * Trigger type determines how Power Automate invokes the trigger.
 */
export type ConnectorTriggerType =
  | 'OpenApiConnection'              // Polling trigger (checks on interval)
  | 'OpenApiConnectionWebhook'       // Webhook (push-based, subscribe/unsubscribe)
  | 'OpenApiConnectionNotification'; // Notification trigger (default)

/**
 * Metadata for a single trigger operation.
 */
export interface TriggerOperationMetadata {
  /** Operation ID as used in Power Automate (e.g., 'GetOnNewItems', 'OnNewEmailV3') */
  name: string;
  /** Human-readable name (e.g., 'When an item is created or modified') */
  displayName: string;
  /** Description of what the trigger does */
  description: string;
  /** Parameters specific to this trigger */
  parameters: ParameterMetadata[];
  /** Default trigger type for this operation */
  triggerType: ConnectorTriggerType;
  /** Whether this trigger typically uses splitOn for batch processing */
  defaultSplitOn?: string;
  /** Whether this trigger needs a polling recurrence */
  needsRecurrence?: boolean;
  /** Default recurrence if polling */
  defaultRecurrence?: { interval: number; frequency: string };
}

/**
 * Metadata for a connector's triggers.
 */
export interface ConnectorTriggerCatalogEntry {
  /** Internal connector name (matches connector metadata) */
  connector: string;
  /** Display name for UI */
  displayName: string;
  /** Default connection reference name pattern */
  defaultConnectionRef: string;
  /** API ID pattern for Logic Apps */
  apiId: string;
  /** Available trigger operations */
  triggers: TriggerOperationMetadata[];
}

// ============= SharePoint Triggers =============

const sharepointTriggers: ConnectorTriggerCatalogEntry = {
  connector: 'sharepoint',
  displayName: 'SharePoint',
  defaultConnectionRef: 'shared_sharepointonline',
  apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
  triggers: [
    {
      name: 'GetOnNewItems',
      displayName: 'When an item is created',
      description: 'Triggers when a new item is created in a SharePoint list.',
      triggerType: 'OpenApiConnection',
      needsRecurrence: true,
      defaultRecurrence: { interval: 1, frequency: 'Minute' },
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [
        param('dataset', 'string', 'SharePoint site URL', true),
        param('table', 'string', 'List name or GUID', true),
      ],
    },
    {
      name: 'GetOnUpdatedItems',
      displayName: 'When an item is created or modified',
      description: 'Triggers when an item is created or modified in a SharePoint list.',
      triggerType: 'OpenApiConnection',
      needsRecurrence: true,
      defaultRecurrence: { interval: 1, frequency: 'Minute' },
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [
        param('dataset', 'string', 'SharePoint site URL', true),
        param('table', 'string', 'List name or GUID', true),
      ],
    },
    {
      name: 'OnFileCreated',
      displayName: 'When a file is created in a folder',
      description: 'Triggers when a new file is created in a SharePoint document library folder.',
      triggerType: 'OpenApiConnection',
      needsRecurrence: true,
      defaultRecurrence: { interval: 1, frequency: 'Minute' },
      parameters: [
        param('dataset', 'string', 'SharePoint site URL', true),
        param('folderId', 'string', 'Folder path (e.g., /Shared Documents)', true),
      ],
    },
    {
      name: 'OnFileUpdated',
      displayName: 'When a file is created or modified in a folder',
      description: 'Triggers when a file is created or modified in a SharePoint document library folder.',
      triggerType: 'OpenApiConnection',
      needsRecurrence: true,
      defaultRecurrence: { interval: 1, frequency: 'Minute' },
      parameters: [
        param('dataset', 'string', 'SharePoint site URL', true),
        param('folderId', 'string', 'Folder path (e.g., /Shared Documents)', true),
      ],
    },
  ],
};

// ============= Dataverse Triggers =============

const dataverseTriggers: ConnectorTriggerCatalogEntry = {
  connector: 'dataverse',
  displayName: 'Dataverse',
  defaultConnectionRef: 'shared_commondataserviceforapps',
  apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
  triggers: [
    {
      name: 'SubscribeWebhookTrigger',
      displayName: 'When a row is added, modified or deleted',
      description: 'Triggers when a Dataverse row is created, updated, or deleted.',
      triggerType: 'OpenApiConnectionWebhook',
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [
        param('subscriptionRequest/message', 'number', 'Message type: 1=Added, 2=Deleted, 3=Modified, 4=Added or Modified, 5=Added or Deleted, 6=Modified or Deleted, 7=Added, Modified, or Deleted', true),
        param('subscriptionRequest/entityname', 'string', 'Table logical name (e.g., account, contact)', true),
        param('subscriptionRequest/scope', 'number', 'Scope: 1=User, 2=BusinessUnit, 3=ParentChildBusinessUnit, 4=Organization', false, 4),
        param('subscriptionRequest/filterexpression', 'string', 'Row filter expression', false),
        param('subscriptionRequest/filteringattributes', 'string', 'Comma-separated column names to filter on', false),
        param('subscriptionRequest/runas', 'number', 'Run as: 1=Modifying user, 2=Row owner, 3=Flow owner', false),
      ],
    },
    {
      name: 'PerformUnboundActionTrigger',
      displayName: 'When an action is performed',
      description: 'Triggers when a Dataverse unbound action is performed.',
      triggerType: 'OpenApiConnectionWebhook',
      parameters: [
        param('subscriptionRequest/sdkmessagename', 'string', 'SDK message name', true),
        param('subscriptionRequest/entityname', 'string', 'Table logical name', false),
      ],
    },
  ],
};

// ============= Office 365 Outlook Triggers =============

const office365Triggers: ConnectorTriggerCatalogEntry = {
  connector: 'office365',
  displayName: 'Office 365 Outlook',
  defaultConnectionRef: 'shared_office365',
  apiId: '/providers/Microsoft.PowerApps/apis/shared_office365',
  triggers: [
    {
      name: 'OnNewEmailV3',
      displayName: 'When a new email arrives (V3)',
      description: 'Triggers when a new email arrives in the specified folder.',
      triggerType: 'OpenApiConnectionNotification',
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [
        param('folderPath', 'string', 'Mail folder (e.g., Inbox)', false, 'Inbox'),
        param('to', 'string', 'To recipients filter', false),
        param('from', 'string', 'From address filter', false),
        param('importance', 'string', 'Importance filter (Any, High, Normal, Low)', false, 'Any'),
        param('fetchOnlyWithAttachment', 'boolean', 'Only trigger for emails with attachments', false, false),
        param('subjectFilter', 'string', 'Subject contains filter', false),
        param('includeAttachments', 'boolean', 'Include attachment content', false, false),
      ],
    },
    {
      name: 'OnFlaggedEmail',
      displayName: 'When an email is flagged',
      description: 'Triggers when an email is flagged in the specified folder.',
      triggerType: 'OpenApiConnectionNotification',
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [
        param('folderPath', 'string', 'Mail folder (e.g., Inbox)', false, 'Inbox'),
      ],
    },
    {
      name: 'OnNewEvent',
      displayName: 'When an upcoming event is starting soon (V3)',
      description: 'Triggers when a calendar event is starting soon.',
      triggerType: 'OpenApiConnectionNotification',
      parameters: [
        param('calendarId', 'string', 'Calendar ID', false, 'Calendar'),
        param('lookAheadTimeInMinutes', 'number', 'Minutes to look ahead', false, 15),
      ],
    },
  ],
};

// ============= Teams Triggers =============

const teamsTriggers: ConnectorTriggerCatalogEntry = {
  connector: 'teams',
  displayName: 'Microsoft Teams',
  defaultConnectionRef: 'shared_teams',
  apiId: '/providers/Microsoft.PowerApps/apis/shared_teams',
  triggers: [
    {
      name: 'OnNewChannelMessage',
      displayName: 'When a new channel message is added',
      description: 'Triggers when a new message is posted to a Teams channel.',
      triggerType: 'OpenApiConnectionNotification',
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [
        param('groupId', 'string', 'Team ID', true),
        param('channelId', 'string', 'Channel ID', true),
      ],
    },
    {
      name: 'OnNewMention',
      displayName: 'When I am mentioned in a channel message',
      description: 'Triggers when the current user is @mentioned in a Teams channel.',
      triggerType: 'OpenApiConnectionNotification',
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [
        param('groupId', 'string', 'Team ID', false),
        param('channelId', 'string', 'Channel ID', false),
      ],
    },
  ],
};

// ============= Approvals Triggers =============

const approvalsTriggers: ConnectorTriggerCatalogEntry = {
  connector: 'approvals',
  displayName: 'Approvals',
  defaultConnectionRef: 'shared_approvals',
  apiId: '/providers/Microsoft.PowerApps/apis/shared_approvals',
  triggers: [
    {
      name: 'OnApprovalCreated',
      displayName: 'When an approval is assigned to me',
      description: 'Triggers when a new approval is assigned to the current user.',
      triggerType: 'OpenApiConnectionWebhook',
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [
        param('approvalType', 'string', 'Approval type filter', false),
      ],
    },
  ],
};

// ============= Office 365 Groups Triggers =============

const office365groupsTriggers: ConnectorTriggerCatalogEntry = {
  connector: 'office365groups',
  displayName: 'Office 365 Groups',
  defaultConnectionRef: 'shared_office365groups',
  apiId: '/providers/Microsoft.PowerApps/apis/shared_office365groups',
  triggers: [
    {
      name: 'OnNewMember',
      displayName: 'When a new member is added to any group',
      description: 'Triggers when a new member is added to any group the user owns or belongs to.',
      triggerType: 'OpenApiConnection',
      needsRecurrence: true,
      defaultRecurrence: { interval: 1, frequency: 'Hour' },
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [],
    },
    {
      name: 'OnNewMemberInGroup',
      displayName: 'When a new member is added to a group',
      description: 'Triggers when a new member is added to a specific group.',
      triggerType: 'OpenApiConnection',
      needsRecurrence: true,
      defaultRecurrence: { interval: 1, frequency: 'Hour' },
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [
        param('groupId', 'string', 'Group ID', true),
      ],
    },
    {
      name: 'OnMemberAddedForMe',
      displayName: 'When I am added to a group',
      description: 'Triggers when the current user is added as a member to any group.',
      triggerType: 'OpenApiConnection',
      needsRecurrence: true,
      defaultRecurrence: { interval: 1, frequency: 'Hour' },
      defaultSplitOn: "@triggerOutputs()?['body/value']",
      parameters: [],
    },
  ],
};

// ============= Catalog Registry =============

const catalog: ConnectorTriggerCatalogEntry[] = [
  sharepointTriggers,
  dataverseTriggers,
  office365Triggers,
  teamsTriggers,
  approvalsTriggers,
  office365groupsTriggers,
];

/**
 * Get all connector trigger catalog entries.
 */
export function getTriggerCatalog(): ConnectorTriggerCatalogEntry[] {
  return catalog;
}

/**
 * Get trigger catalog for a specific connector.
 */
export function getConnectorTriggers(connectorName: string): ConnectorTriggerCatalogEntry | undefined {
  return catalog.find(c => c.connector === connectorName);
}

/**
 * Get a specific trigger operation from a connector.
 */
export function getTriggerOperation(
  connectorName: string,
  operationName: string,
): TriggerOperationMetadata | undefined {
  const entry = catalog.find(c => c.connector === connectorName);
  return entry?.triggers.find(t => t.name === operationName);
}

/**
 * Get all connector names that have triggers.
 */
export function getConnectorNamesWithTriggers(): string[] {
  return catalog.map(c => c.connector);
}
