/**
 * Generated DSL must use a single line ending throughout.
 *
 * Descriptions authored in the Power Automate maker UI carry CRLF. The
 * generator embeds them verbatim into comments, so a stray \r would leave the
 * generated source with mixed EOL. Monaco normalizes every model to one EOL,
 * so a mixed-EOL string never round-trips byte-for-byte through the editor —
 * which made a freshly opened flow look like it had unsaved user edits.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateNativeDslFromIR } from '../src/generator.js';
import type { FlowIR } from '@flowforger/ir';

function irWithCrlfDescriptions(): FlowIR {
  return {
    name: 'CrlfFlow',
    description: 'Line one.\r\nLine two.\r\nLine three.',
    nodes: [
      { id: 'trg_1', type: 'trigger', kind: 'manual', name: 'manual' },
      {
        id: 'act_1',
        type: 'action',
        kind: 'compose',
        name: 'Compose',
        description: 'Action desc\r\nsecond line',
        inputs: { value: 'x' },
      },
    ],
  } as unknown as FlowIR;
}

describe('generateNativeDslFromIR line endings', () => {
  it('emits no carriage returns when descriptions contain CRLF', () => {
    const dsl = generateNativeDslFromIR(irWithCrlfDescriptions(), { flowName: 'CrlfFlow' });

    assert.strictEqual(
      dsl.includes('\r'),
      false,
      'generated DSL must not contain \\r — mixed EOL breaks editor round-tripping'
    );
  });

  it('preserves the description text across the CRLF split', () => {
    const dsl = generateNativeDslFromIR(irWithCrlfDescriptions(), { flowName: 'CrlfFlow' });

    assert.ok(dsl.includes('Line one.'), 'first description line missing');
    assert.ok(dsl.includes('Line two.'), 'second description line missing');
    assert.ok(dsl.includes('Line three.'), 'third description line missing');
    assert.ok(dsl.includes('Action desc'), 'action description first line missing');
    assert.ok(dsl.includes('second line'), 'action description second line missing');
  });

  it('is byte-identical to its own EOL-normalized form', () => {
    const dsl = generateNativeDslFromIR(irWithCrlfDescriptions(), { flowName: 'CrlfFlow' });

    assert.strictEqual(dsl.replace(/\r\n|\r/g, '\n'), dsl);
  });
});
