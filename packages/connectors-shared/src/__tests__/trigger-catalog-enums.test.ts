/**
 * The trigger catalog exposes the same named enum values the DSL uses
 * (DataverseMessage / DataverseScope / DataverseRunAs) as `allowedValues`,
 * so UI pickers and the DSL never drift apart.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getTriggerCatalog } from '../trigger-catalog.js';
import { DataverseMessage, DataverseScope, DataverseRunAs } from '@flowforger/ir';

function dataverseParam(name: string) {
  const dv = getTriggerCatalog().find(c => c.connector === 'dataverse')!;
  const trig = dv.triggers.find(t => t.name === 'SubscribeWebhookTrigger')!;
  return trig.parameters.find(p => p.name === name)!;
}

describe('trigger catalog enum values', () => {
  it('message/scope/runas carry allowedValues matching the DSL enums', () => {
    const toPairs = (o: Record<string, number>) =>
      Object.entries(o).map(([label, value]) => ({ label, value }));
    assert.deepStrictEqual(dataverseParam('subscriptionRequest/message').allowedValues, toPairs(DataverseMessage));
    assert.deepStrictEqual(dataverseParam('subscriptionRequest/scope').allowedValues, toPairs(DataverseScope));
    assert.deepStrictEqual(dataverseParam('subscriptionRequest/runas').allowedValues, toPairs(DataverseRunAs));
  });

  it('entityname has no allowedValues', () => {
    assert.strictEqual(dataverseParam('subscriptionRequest/entityname').allowedValues, undefined);
  });
});
