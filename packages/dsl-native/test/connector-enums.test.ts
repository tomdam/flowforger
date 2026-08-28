/**
 * Named enums for connector trigger parameters (e.g. DataverseMessage.AddedOrModified
 * instead of the magic number 4). The DSL is import-free: the names are ambient
 * globals resolved statically by the transformer, and the generator emits them back
 * when the (connector, operation, param) is registered.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { transformCode } from '../src/transformer/index.js';
import { generateNativeDslFromIR } from '../src/generator.js';
import { resetIdCounter } from '../src/utils/id-generator.js';
import {
  DataverseMessage,
  DataverseScope,
  DataverseRunAs,
  resolveConnectorEnumMember,
  findConnectorEnumForParam,
} from '../src/connector-enums.js';
import { monacoTypeDefinitions } from '../src/monaco-types.js';

const DSL = `
@Flow('enum-trigger')
class EnumTrigger {
  @ConnectorTrigger()
  trigger(ctx: FlowContext) {
    return {
      connector: "dataverse",
      operation: "SubscribeWebhookTrigger",
      params: {
        "subscriptionRequest/message": DataverseMessage.AddedOrModified,
        "subscriptionRequest/entityname": "brk_fibuexport",
        "subscriptionRequest/scope": DataverseScope.BusinessUnit,
        "subscriptionRequest/runas": DataverseRunAs.FlowOwner,
      },
      connectionReferenceName: "shared_commondataserviceforapps",
      triggerType: "OpenApiConnectionWebhook",
    };
  }

  @Action()
  async run(ctx: FlowContext) {}
}
`;

describe('connector enums', () => {
  beforeEach(() => resetIdCounter());

  it('exposes the Dataverse webhook enum values', () => {
    assert.strictEqual(DataverseMessage.AddedOrModified, 4);
    assert.strictEqual(DataverseScope.BusinessUnit, 2);
    assert.strictEqual(DataverseRunAs.FlowOwner, 3);
  });

  it('resolves a registered member by name and rejects unknown ones', () => {
    assert.strictEqual(resolveConnectorEnumMember('DataverseMessage', 'AddedOrModified'), 4);
    assert.strictEqual(resolveConnectorEnumMember('DataverseMessage', 'Nope'), undefined);
    assert.strictEqual(resolveConnectorEnumMember('SomethingElse', 'Added'), undefined);
  });

  it('maps a trigger parameter to its enum', () => {
    const found = findConnectorEnumForParam('dataverse', 'SubscribeWebhookTrigger', 'subscriptionRequest/scope');
    assert.strictEqual(found?.name, 'DataverseScope');
    assert.strictEqual(findConnectorEnumForParam('dataverse', 'SubscribeWebhookTrigger', 'subscriptionRequest/entityname'), undefined);
    assert.strictEqual(findConnectorEnumForParam('sharepoint', 'GetOnNewItems', 'subscriptionRequest/scope'), undefined);
  });

  it('transformer resolves enum members to their numeric values in the IR', () => {
    const ir = transformCode(DSL);
    const trigger = ir.nodes[0] as any;
    assert.strictEqual(trigger.kind, 'connector');
    assert.deepStrictEqual(trigger.inputs.params, {
      'subscriptionRequest/message': 4,
      'subscriptionRequest/entityname': 'brk_fibuexport',
      'subscriptionRequest/scope': 2,
      'subscriptionRequest/runas': 3,
    });
  });

  it('generator emits enum members for registered params and round-trips', () => {
    const ir = transformCode(DSL);
    const dsl = generateNativeDslFromIR(ir);
    assert.match(dsl, /"subscriptionRequest\/message": DataverseMessage\.AddedOrModified/);
    assert.match(dsl, /"subscriptionRequest\/scope": DataverseScope\.BusinessUnit/);
    assert.match(dsl, /"subscriptionRequest\/runas": DataverseRunAs\.FlowOwner/);
    assert.match(dsl, /"subscriptionRequest\/entityname": "brk_fibuexport"/);
    assert.ok(!dsl.includes('import '), 'generated DSL must stay import-free');

    const ir2 = transformCode(dsl);
    assert.deepStrictEqual((ir2.nodes[0] as any).inputs.params, (ir.nodes[0] as any).inputs.params);
  });

  it('generator falls back to the raw number for values outside the enum', () => {
    const ir = transformCode(DSL);
    (ir.nodes[0] as any).inputs.params['subscriptionRequest/message'] = 99;
    const dsl = generateNativeDslFromIR(ir);
    assert.match(dsl, /"subscriptionRequest\/message": 99/);
  });

  it('generator leaves numbers alone for unregistered connector/operation', () => {
    const ir = transformCode(DSL);
    (ir.nodes[0] as any).inputs.operation = 'PerformUnboundActionTrigger';
    const dsl = generateNativeDslFromIR(ir);
    assert.match(dsl, /"subscriptionRequest\/message": 4/);
  });

  it('ambient Monaco types declare the enums as globals with literal member types', () => {
    assert.match(monacoTypeDefinitions, /declare const DataverseMessage: \{[^}]*readonly AddedOrModified: 4/s);
    assert.match(monacoTypeDefinitions, /declare const DataverseScope: \{[^}]*readonly BusinessUnit: 2/s);
    assert.match(monacoTypeDefinitions, /declare const DataverseRunAs: \{[^}]*readonly FlowOwner: 3/s);
  });
});
