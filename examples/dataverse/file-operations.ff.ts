/**
 * Example: Dataverse — File / Image Operations
 *
 * Reads and writes binary content (image fields and annotation file bodies)
 * using GetEntityFileImageFieldContent / UpdateEntityFileImageFieldContent.
 * `content` values are base64-encoded.
 */

@Flow('dv-file-operations')
class DvFileOperations {
  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.dataverse.GetEntityFileImageFieldContent('GetContactPhoto', {
      entityName: 'contacts',
      recordId: '00000000-0000-0000-0000-000000000001',
      fieldName: 'entityimage',
    });

    await ctx.connectors.dataverse.UpdateEntityFileImageFieldContent('UploadContactPhoto', {
      entityName: 'contacts',
      recordId: '00000000-0000-0000-0000-000000000002',
      fieldName: 'entityimage',
      content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    });

    await ctx.connectors.dataverse.GetEntityFileImageFieldContent('GetAnnotationFile', {
      entityName: 'annotations',
      recordId: '00000000-0000-0000-0000-000000000003',
      fieldName: 'documentbody',
    });

    await ctx.connectors.dataverse.UpdateEntityFileImageFieldContent('UploadAnnotationFile', {
      entityName: 'annotations',
      recordId: '00000000-0000-0000-0000-000000000004',
      fieldName: 'documentbody',
      content: 'VGhpcyBpcyBhIHRlc3QgZmlsZSBjb250ZW50IGVuY29kZWQgaW4gYmFzZTY0',
    });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.metadata = {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      schemaVersion: '1.0.0.0',
    };
    ctx.flow.connectionReferences = {
      shared_commondataserviceforapps: { apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' },
    };
    ctx.flow.parameters = {
      $connections: { defaultValue: {}, type: 'Object' },
      $authentication: { defaultValue: {}, type: 'SecureObject' },
    };
  }
}
