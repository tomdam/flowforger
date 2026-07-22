/**
 * Word Online Connector Metadata
 *
 * Defines Word Online operations with their parameters and documentation.
 * Used by the language service for completions and hover docs.
 */

import {
  type ConnectorMetadata,
  param,
  operation,
  connector,
} from '@flowforger/connectors-shared';

export const wordOnlineMetadata: ConnectorMetadata = connector(
  'wordOnline',
  'Word Online (Business)',
  'Microsoft Word Online connector for document generation and conversion.',
  [
    operation('PopulateWordTemplate', 'Populate a Word template with dynamic content.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'PopulateWordTemplateParams', 'Operation parameters'),
    ], {
      category: 'Templates',
      examples: [`ctx.connectors.wordOnline.PopulateWordTemplate('GenerateContract', {\n  source: 'OneDrive',\n  driveId: 'drive-id',\n  fileId: 'template-file-id',\n  templateData: {\n    CustomerName: 'Contoso Ltd',\n    Date: '2024-01-15'\n  }\n});`],
    }),

    operation('ConvertToPdf', 'Convert a Word document to PDF.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ConvertToPdfParams', 'Operation parameters'),
    ], {
      category: 'Conversion',
      examples: [`ctx.connectors.wordOnline.ConvertToPdf('ConvertDoc', {\n  source: 'OneDrive',\n  driveId: 'drive-id',\n  fileId: 'file-id'\n});`],
    }),
  ],
  {
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/wordonlinebusiness/',
  }
);

/**
 * Word Online uses Graph API Files scope for all operations.
 */
export const wordonlineScopes = { default: ['Files.ReadWrite'] };

export default wordOnlineMetadata;
