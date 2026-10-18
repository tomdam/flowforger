import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowForgerConfig } from '@flowforger/ir';
import { DEFAULT_CONFIG } from '@flowforger/ir';
import { transformCode } from '@flowforger/dsl-native';
import { emitLogicAppsJson } from '@flowforger/emitter-logicapps';
import { diffDefinitions, formatDiffReport, liveOnlyNames } from '../definition-diff.js';

/** A designer-shaped clientdata envelope with a trigger, a scope and a nested condition. */
function liveFlow(): any {
  return {
    properties: {
      connectionReferences: {
        shared_sharepointonline: {
          connectionName: 'abc-123',
          source: 'Invoker',
          id: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
        },
      },
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        description: 'Live description',
        parameters: {
          $connections: { defaultValue: {}, type: 'Object' },
          $authentication: { defaultValue: {}, type: 'SecureObject' },
          'Site URL (cr_SiteUrl)': { defaultValue: 'https://contoso.sharepoint.com/sites/A', type: 'String', metadata: { schemaName: 'cr_SiteUrl' } },
        },
        triggers: {
          manual: {
            type: 'Request',
            kind: 'Http',
            inputs: { schema: { type: 'object', properties: { id: { type: 'string' } } } },
            metadata: { operationMetadataId: 'trg-meta-1' },
          },
        },
        actions: {
          Compose_A: {
            type: 'Compose',
            runAfter: {},
            inputs: { a: 1 },
            metadata: { operationMetadataId: 'meta-1' },
          },
          Try: {
            type: 'Scope',
            runAfter: { Compose_A: ['Succeeded'] },
            metadata: { operationMetadataId: 'meta-2' },
            actions: {
              Get_items: {
                type: 'OpenApiConnection',
                runAfter: {},
                inputs: {
                  host: {
                    apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
                    operationId: 'GetItems',
                    connectionName: 'shared_sharepointonline',
                  },
                  parameters: {
                    dataset: "@parameters('Site URL (cr_SiteUrl)')",
                    table: 'list-guid',
                    '$filter': "Status eq 'Open'",
                  },
                  authentication: "@parameters('$authentication')",
                },
                metadata: { operationMetadataId: 'meta-3' },
              },
              Check: {
                type: 'If',
                runAfter: { Get_items: ['Succeeded'] },
                expression: { and: [{ equals: ["@length(body('Get_items')?['value'])", 0] }] },
                actions: {
                  Compose_none: { type: 'Compose', runAfter: {}, inputs: 'none' },
                },
                else: {
                  actions: {
                    Compose_some: { type: 'Compose', runAfter: {}, inputs: 'some' },
                  },
                },
              },
            },
          },
          Compose_Z: {
            type: 'Compose',
            runAfter: { Try: ['Succeeded', 'Failed'] },
            inputs: "@outputs('Compose_A')",
          },
        },
      },
    },
    schemaVersion: '1.0.0.0',
  };
}

/** Deep clone, so each test mutates its own copy. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('diffDefinitions — identity and tolerance', () => {
  it('reports identical for two copies of the same flow', () => {
    const report = diffDefinitions(liveFlow(), liveFlow());
    assert.equal(report.identical, true);
    assert.deepEqual(report.summary, { onlyLocal: 0, onlyLive: 0, changed: 0, compared: 7 });
    assert.deepEqual(report.actions, []);
  });

  it('ignores key order, operationMetadataId, empty runAfter and the default authentication', () => {
    const local = clone(liveFlow());
    const def = local.properties.definition;
    // Reorder keys of an action and drop the noise the emitter would not write the same way.
    const a = def.actions.Compose_A;
    def.actions.Compose_A = { inputs: a.inputs, type: a.type };
    delete def.actions.Try.metadata;
    delete def.actions.Try.actions.Get_items.metadata;
    delete def.actions.Try.actions.Get_items.inputs.authentication;
    def.actions.Try.actions.Get_items.metadata = { operationMetadataId: 'another' };
    // The envelope key order and a differently-ordered parameters map.
    const params = def.parameters;
    def.parameters = { 'Site URL (cr_SiteUrl)': params['Site URL (cr_SiteUrl)'], $authentication: params.$authentication, $connections: params.$connections };
    const report = diffDefinitions(liveFlow(), local);
    assert.equal(report.identical, true, JSON.stringify(report, null, 2));
  });

  it('ignores the metadata keys listed in parser.skipMetadataFields', () => {
    const local = clone(liveFlow());
    local.properties.definition.actions.Compose_A.metadata = { operationMetadataId: 'x', flowSystemMetadata: { x: 1 } };
    const config: FlowForgerConfig = { ...DEFAULT_CONFIG, parser: { ...DEFAULT_CONFIG.parser, skipMetadataFields: ['flowSystemMetadata'] } };
    assert.equal(diffDefinitions(liveFlow(), local).identical, false);
    assert.equal(diffDefinitions(liveFlow(), local, { config }).identical, true);
  });

  it('treats item/field keys and a nested item object as the same inputs', () => {
    const live = clone(liveFlow());
    const local = clone(liveFlow());
    live.properties.definition.actions.Compose_A.inputs = { 'item/Title': 'x', 'item/Status/Value': 'Open' };
    local.properties.definition.actions.Compose_A.inputs = { item: { Title: 'x', Status: { Value: 'Open' } } };
    assert.equal(diffDefinitions(live, local).identical, true);
  });

  it('ignores CRLF vs LF line endings in a description (a Windows checkout pushes CRLF, the cloud stores LF)', () => {
    const local = clone(liveFlow());
    local.properties.definition.description = 'line one\r\nline two';
    local.properties.definition.actions.Compose_A.description = 'a\r\nb';
    const live = clone(liveFlow());
    live.properties.definition.description = 'line one\nline two';
    live.properties.definition.actions.Compose_A.description = 'a\nb';
    assert.equal(diffDefinitions(live, local).identical, true);
  });

  it('normalizes expression whitespace and function case', () => {
    const local = clone(liveFlow());
    local.properties.definition.actions.Compose_Z.inputs = "@Outputs( 'Compose_A' )";
    assert.equal(diffDefinitions(liveFlow(), local).identical, true);
  });
});

describe('diffDefinitions — per-action report', () => {
  it('reports an action only the local file has, with its container and type', () => {
    const local = clone(liveFlow());
    local.properties.definition.actions.Try.actions.Send_mail = { type: 'Compose', runAfter: { Check: ['Succeeded'] }, inputs: 'mail' };
    const report = diffDefinitions(liveFlow(), local);
    assert.equal(report.identical, false);
    assert.deepEqual(report.actions, [
      { name: 'Send_mail', status: 'only-local', container: { local: 'Try' }, type: { local: 'Compose' }, kinds: [], changes: [] },
    ]);
    assert.deepEqual(report.summary, { onlyLocal: 1, onlyLive: 0, changed: 0, compared: 8 });
  });

  it('reports an action only the live flow has, including one nested in an else branch', () => {
    const local = clone(liveFlow());
    delete local.properties.definition.actions.Try.actions.Check.else;
    const report = diffDefinitions(liveFlow(), local);
    const onlyLive = report.actions.filter((a) => a.status === 'only-live');
    assert.deepEqual(onlyLive.map((a) => [a.name, a.container?.live]), [['Compose_some', 'Try/Check (else)']]);
    assert.deepEqual(liveOnlyNames(report), ["action 'Compose_some'"]);
    assert.equal(report.summary.onlyLive, 1);
  });

  it('classifies changed inputs, runAfter, expression and type', () => {
    const local = clone(liveFlow());
    const def = local.properties.definition;
    def.actions.Try.actions.Get_items.inputs.parameters.$filter = "Status eq 'Closed'";
    def.actions.Compose_Z.runAfter = { Try: ['Succeeded'] };
    def.actions.Try.actions.Check.expression = { and: [{ equals: ["@length(body('Get_items')?['value'])", 1] }] };
    def.actions.Compose_A.type = 'ParseJson';
    const report = diffDefinitions(liveFlow(), local);
    const byName = Object.fromEntries(report.actions.map((a) => [a.name, a]));

    assert.deepEqual(byName.Get_items.kinds, ['inputs']);
    assert.deepEqual(byName.Get_items.changes, [
      { path: 'inputs.parameters.$filter', live: "Status eq 'Open'", local: "Status eq 'Closed'" },
    ]);
    assert.deepEqual(byName.Compose_Z.kinds, ['runAfter']);
    assert.deepEqual(byName.Compose_Z.changes, [{ path: 'runAfter.Try[1]', live: 'Failed' }]);
    assert.deepEqual(byName.Check.kinds, ['expression']);
    assert.deepEqual(byName.Compose_A.kinds, ['type']);
    assert.deepEqual(byName.Compose_A.type, { live: 'Compose', local: 'ParseJson' });
    assert.equal(report.summary.changed, 4);
  });

  it('reports a moved action (same name, other container) as changed with kind moved', () => {
    const local = clone(liveFlow());
    const def = local.properties.definition;
    const z = def.actions.Compose_Z;
    delete def.actions.Compose_Z;
    def.actions.Try.actions.Compose_Z = { ...z, runAfter: { Check: ['Succeeded'] } };
    const report = diffDefinitions(liveFlow(), local);
    assert.equal(report.actions.length, 1);
    const [z2] = report.actions;
    assert.equal(z2.status, 'changed');
    assert.deepEqual(z2.kinds, ['runAfter', 'moved']);
    assert.deepEqual(z2.container, { live: '', local: 'Try' });
    assert.ok(z2.changes.some((c) => c.path === 'container' && c.live === '' && c.local === 'Try'));
  });

  it('does not report a container as changed when only its children changed', () => {
    const local = clone(liveFlow());
    local.properties.definition.actions.Try.actions.Get_items.inputs.parameters.table = 'other-guid';
    const report = diffDefinitions(liveFlow(), local);
    assert.deepEqual(report.actions.map((a) => a.name), ['Get_items']);
  });

  it('reports a switch case rename on the switch and its actions under the case container', () => {
    const live = clone(liveFlow());
    const local = clone(liveFlow());
    const mkSwitch = (caseName: string, value: string) => ({
      type: 'Switch',
      runAfter: { Compose_A: ['Succeeded'] },
      expression: "@triggerBody()?['kind']",
      cases: { [caseName]: { case: value, actions: { In_case: { type: 'Compose', runAfter: {}, inputs: value } } } },
      default: { actions: {} },
    });
    live.properties.definition.actions.Route = mkSwitch('Case_a', 'a');
    local.properties.definition.actions.Route = mkSwitch('Case_b', 'b');
    const report = diffDefinitions(live, local);
    const byName = Object.fromEntries(report.actions.map((a) => [a.name, a]));
    assert.deepEqual(byName.Route.kinds, ['other']);
    assert.deepEqual(byName.In_case.kinds, ['inputs', 'moved']);
    assert.deepEqual(byName.In_case.container, { live: 'Route (case Case_a)', local: 'Route (case Case_b)' });
  });
});

describe('diffDefinitions — trigger, parameters, flow fields, connection references', () => {
  it('reports a changed trigger', () => {
    const local = clone(liveFlow());
    local.properties.definition.triggers.manual.inputs.schema.properties.id.type = 'integer';
    const report = diffDefinitions(liveFlow(), local);
    assert.deepEqual(report.triggers.map((t) => [t.name, t.status, t.kinds]), [['manual', 'changed', ['inputs']]]);
    assert.equal(report.summary.changed, 1);
  });

  it('reports a renamed trigger as only-live plus only-local', () => {
    const local = clone(liveFlow());
    local.properties.definition.triggers = { When_a_request_arrives: liveFlow().properties.definition.triggers.manual };
    const report = diffDefinitions(liveFlow(), local);
    assert.deepEqual(report.triggers.map((t) => [t.name, t.status]), [['manual', 'only-live'], ['When_a_request_arrives', 'only-local']]);
  });

  it('reports parameter additions, removals and changed defaults; ignores the default $connections', () => {
    const local = clone(liveFlow());
    const params = local.properties.definition.parameters;
    params['Site URL (cr_SiteUrl)'].defaultValue = 'https://contoso.sharepoint.com/sites/B';
    params['List ID (cr_ListId)'] = { defaultValue: 'guid', type: 'String' };
    delete params.$connections;
    const report = diffDefinitions(liveFlow(), local);
    assert.deepEqual(report.parameters.map((p) => [p.name, p.status]), [
      ['Site URL (cr_SiteUrl)', 'changed'],
      ['List ID (cr_ListId)', 'only-local'],
    ]);
    assert.deepEqual(report.parameters[0].changes, [
      { path: 'defaultValue', live: 'https://contoso.sharepoint.com/sites/A', local: 'https://contoso.sharepoint.com/sites/B' },
    ]);
    assert.equal(report.parameters[0].container, undefined);
  });

  it('reports a changed flow description under flow', () => {
    const local = clone(liveFlow());
    local.properties.definition.description = 'Local description';
    const report = diffDefinitions(liveFlow(), local);
    assert.deepEqual(report.flow, [{ path: 'description', live: 'Live description', local: 'Local description' }]);
    assert.equal(report.identical, false);
    assert.deepEqual(report.actions, []);
  });

  it('lists connection reference value differences without counting them', () => {
    const local = clone(liveFlow());
    local.properties.connectionReferences.shared_sharepointonline = {
      connectionName: 'shared_sharepointonline',
      runtimeSource: 'embedded',
      api: { name: 'shared_sharepointonline' },
    };
    const report = diffDefinitions(liveFlow(), local);
    assert.equal(report.identical, true);
    assert.deepEqual(report.connectionReferences, { onlyLive: [], onlyLocal: [], valueDifferences: ['shared_sharepointonline'] });
  });

  it('counts a connection reference key that only one side has', () => {
    const local = clone(liveFlow());
    local.properties.connectionReferences.shared_office365 = { connectionName: 'x', source: 'Invoker', id: 'y' };
    delete local.properties.connectionReferences.shared_sharepointonline;
    const report = diffDefinitions(liveFlow(), local);
    assert.equal(report.identical, false);
    assert.deepEqual(report.connectionReferences, { onlyLive: ['shared_sharepointonline'], onlyLocal: ['shared_office365'], valueDifferences: [] });
  });

  it('accepts a bare definition and a standalone { definition } wrapper', () => {
    const bare = liveFlow().properties.definition;
    const wrapped = { definition: liveFlow().properties.definition };
    assert.equal(diffDefinitions(bare, wrapped).identical, true);
  });
});

describe('diffDefinitions — compiled DSL on both sides', () => {
  const dsl = (filter: string, extra = '') => `
@Flow('Diff Demo')
class DiffDemo {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.connectors.sharepoint.GetItems('Get_items', {
      dataset: ctx.parameters('Site URL (cr_SiteUrl)'),
      table: 'list-guid',
      $filter: "${filter}",
    }, 'shared_sharepointonline');
    ${extra}
    await ctx.response('Respond', 200, { count: ctx.length(ctx.body('Get_items')?.['value']) });
  }

  constructor(ctx: FlowContext) {
    ctx.flow.connectionReferences = {
      shared_sharepointonline: { connectionName: 'shared_sharepointonline', runtimeSource: 'embedded', api: { name: 'shared_sharepointonline' } },
    };
    ctx.flow.parameters = {
      '$connections': { defaultValue: {}, type: 'Object' },
      '$authentication': { defaultValue: {}, type: 'SecureObject' },
      'Site URL (cr_SiteUrl)': { type: 'String', defaultValue: 'https://contoso.sharepoint.com/sites/A', metadata: { schemaName: 'cr_SiteUrl' } },
    };
  }
}`;
  const compile = (code: string) => emitLogicAppsJson(transformCode(code));

  it('is identical for the same DSL compiled twice', () => {
    assert.equal(diffDefinitions(compile(dsl("Status eq 'Open'")), compile(dsl("Status eq 'Open'"))).identical, true);
  });

  it('finds exactly the edited filter and the added action', () => {
    const live = compile(dsl("Status eq 'Open'"));
    const local = compile(dsl("Status eq 'Closed'", "await ctx.compose('Note', 'added');"));
    const report = diffDefinitions(live, local);
    assert.deepEqual(report.actions.map((a) => [a.name, a.status, a.kinds]), [
      ['Get_items', 'changed', ['inputs']],
      ['Respond', 'changed', ['runAfter']],
      ['Note', 'only-local', []],
    ]);
    assert.deepEqual(report.triggers, []);
    assert.deepEqual(report.parameters, []);
  });
});

describe('formatDiffReport', () => {
  const ctx = { flowName: 'Diff Demo', workflowId: 'guid-1', file: 'flow.ff.ts' };

  it('prints one line for an identical flow', () => {
    const lines = formatDiffReport(diffDefinitions(liveFlow(), liveFlow()), ctx);
    assert.deepEqual(lines, ["Flow 'Diff Demo' (guid-1) vs local flow.ff.ts: identical (7 actions compared)"]);
  });

  it('prints the differences grouped by section', () => {
    const local = clone(liveFlow());
    const def = local.properties.definition;
    def.actions.Try.actions.Get_items.inputs.parameters.$filter = "Status eq 'Closed'";
    def.actions.New_one = { type: 'Compose', runAfter: { Compose_Z: ['Succeeded'] }, inputs: 1 };
    delete def.actions.Try.actions.Check.else;
    def.description = 'Local';
    local.properties.connectionReferences.shared_sharepointonline.connectionName = 'other';
    const lines = formatDiffReport(diffDefinitions(liveFlow(), local), ctx);
    assert.equal(lines[0], "Flow 'Diff Demo' (guid-1) vs local flow.ff.ts: 4 differences (live → local)");
    assert.ok(lines.includes('Actions:'));
    assert.ok(lines.some((l) => /^  - Compose_some\s+only live\s+\[Compose, in Try\/Check \(else\)\]$/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /^  \+ New_one\s+only local\s+\[Compose, at root\]$/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /^  ~ Get_items\s+changed \(inputs\)$/.test(l)), lines.join('\n'));
    assert.ok(lines.includes(`      inputs.parameters.$filter: "Status eq 'Open'" → "Status eq 'Closed'"`));
    assert.ok(lines.includes('Flow:'));
    assert.ok(lines.includes('  description: "Live description" → "Local"'));
    assert.ok(lines.some((l) => l.startsWith('Connection references: values differ (not counted')));
  });
});
