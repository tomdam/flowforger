/**
 * Dataverse Connector Metadata
 *
 * Defines all Dataverse/Dynamics 365 operations with their parameters and documentation.
 * Used by the language service for completions and hover docs.
 */

import {
  type ConnectorMetadata,
  param,
  operation,
  connector,
} from '@flowforger/connectors-shared';

export const dataverseMetadata: ConnectorMetadata = connector(
  'dataverse',
  'Dataverse',
  'Dataverse (formerly Common Data Service) connector for working with Microsoft Dataverse and Dynamics 365 tables.',
  [
    // ============= CRUD Operations =============
    operation(
      'ListRows',
      'List rows from a Dataverse table with optional filtering.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'ListRowsParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Tables',
        examples: [
          `ctx.connectors.dataverse.ListRows('GetAccounts', {
  entityName: 'accounts',
  $filter: "statecode eq 0",
  $select: 'name,accountnumber,revenue',
  $top: 50
});`,
        ],
      }
    ),
    operation(
      'GetRow',
      'Get a single row by ID from a Dataverse table.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetRowParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Tables',
        examples: [
          `ctx.connectors.dataverse.GetRow('GetAccount', {
  entityName: 'accounts',
  recordId: 'account-guid-here',
  $select: 'name,accountnumber'
});`,
        ],
      }
    ),
    operation(
      'CreateRow',
      'Create a new row in a Dataverse table.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'CreateRowParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Tables',
        examples: [
          `ctx.connectors.dataverse.CreateRow('CreateAccount', {
  entityName: 'accounts',
  item: {
    name: 'Contoso Ltd',
    accountnumber: 'ACC-001',
    revenue: 1000000
  }
});`,
        ],
      }
    ),
    operation(
      'UpdateRow',
      'Update an existing row in a Dataverse table.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'UpdateRowParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Tables',
        examples: [
          `ctx.connectors.dataverse.UpdateRow('UpdateAccount', {
  entityName: 'accounts',
  recordId: 'account-guid-here',
  item: { revenue: 2000000 }
});`,
        ],
      }
    ),
    operation(
      'DeleteRow',
      'Delete a row from a Dataverse table.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'DeleteRowParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Tables',
        examples: [
          `ctx.connectors.dataverse.DeleteRow('DeleteAccount', {
  entityName: 'accounts',
  recordId: 'account-guid-here'
});`,
        ],
      }
    ),
    operation(
      'UpsertRow',
      'Update or insert a row based on alternate key or ID.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'UpsertRowParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Tables',
        examples: [
          `ctx.connectors.dataverse.UpsertRow('UpsertAccount', {
  entityName: 'accounts',
  recordId: 'account-guid-here',
  item: { name: 'Contoso Ltd', revenue: 1500000 }
});`,
        ],
      }
    ),

    // ============= Relationship Operations =============
    operation(
      'AssociateRecords',
      'Associate two records through a relationship.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'AssociateRecordsParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Relationships',
        examples: [
          `ctx.connectors.dataverse.AssociateRecords('LinkContactToAccount', {
  entityName: 'accounts',
  recordId: 'account-guid',
  relationshipName: 'contact_customer_accounts',
  relatedEntityName: 'contacts',
  relatedRecordId: 'contact-guid'
});`,
        ],
      }
    ),
    operation(
      'DisassociateRecords',
      'Remove the association between two records.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'DisassociateRecordsParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Relationships',
      }
    ),

    // ============= Action Operations =============
    operation(
      'PerformBoundAction',
      'Execute a bound action on a specific record.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'PerformBoundActionParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Actions',
        examples: [
          `ctx.connectors.dataverse.PerformBoundAction('WinOpportunity', {
  entityName: 'opportunities',
  recordId: 'opportunity-guid',
  actionName: 'WinOpportunity',
  Status: 3,
  OpportunityClose: {
    subject: 'Won the deal',
    opportunityid: { '@odata.type': 'Microsoft.Dynamics.CRM.opportunity', opportunityid: 'opportunity-guid' }
  }
});`,
        ],
      }
    ),
    operation(
      'PerformUnboundAction',
      'Execute an unbound (global) action.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'PerformUnboundActionParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Actions',
        examples: [
          `ctx.connectors.dataverse.PerformUnboundAction('WhoAmI', {
  actionName: 'WhoAmI'
});`,
        ],
      }
    ),

    // ============= File Operations =============
    operation(
      'GetFileContent',
      'Get the content of a file or image field.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetFileContentParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
        examples: [
          `ctx.connectors.dataverse.GetFileContent('DownloadDocument', {
  entityName: 'annotations',
  recordId: 'annotation-guid',
  fieldName: 'documentbody'
});`,
        ],
      }
    ),
    operation(
      'UploadFileContent',
      'Upload content to a file or image field.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'UploadFileContentParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Files',
        examples: [
          `ctx.connectors.dataverse.UploadFileContent('UploadDocument', {
  entityName: 'annotations',
  recordId: 'annotation-guid',
  fieldName: 'documentbody',
  content: base64Content
});`,
        ],
      }
    ),

    // ============= Batch Operations =============
    operation(
      'ExecuteChangeset',
      'Execute multiple operations as a single atomic transaction.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'ExecuteChangesetParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Batch',
        examples: [
          `ctx.connectors.dataverse.ExecuteChangeset('BatchCreate', {
  requests: [
    { method: 'POST', entityName: 'accounts', body: { name: 'Account 1' } },
    { method: 'POST', entityName: 'accounts', body: { name: 'Account 2' } }
  ]
});`,
        ],
      }
    ),

    // ============= Search Operations =============
    operation(
      'GetRelevantRows',
      'Search for rows using Dataverse relevance search.',
      [
        param('actionName', 'string', 'Unique name for this action'),
        param('params', 'GetRelevantRowsParams', 'Operation parameters'),
      ],
      {
        returnType: 'void',
        category: 'Search',
        examples: [
          `ctx.connectors.dataverse.GetRelevantRows('SearchAccounts', {
  searchText: 'Contoso',
  entities: ['accounts', 'contacts'],
  top: 10
});`,
        ],
      }
    ),
  ],
  {
    docsUrl: 'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview',
  }
);

/**
 * Dataverse uses a single scope for all operations.
 * The actual scope URL is resource-specific: {dataverseUrl}/user_impersonation
 */
export const dataverseScopes = { default: ['user_impersonation'] };

export default dataverseMetadata;
