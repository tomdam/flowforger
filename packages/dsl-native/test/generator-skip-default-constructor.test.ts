/**
 * Tests for the `skipDefaultConstructor` generator option: when enabled, the
 * generator omits the constructor if all of its content is default boilerplate
 * that the Logic Apps emitter re-injects on compile.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateNativeDslFromIR } from '../src/generator.js';
import type { FlowIR } from '@flowforger/ir';

const DEFAULT_METADATA = {
  $schema:
    'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
  contentVersion: '1.0.0.0',
  schemaVersion: '1.0.0.0',
};

const DEFAULT_PARAMETERS = {
  $connections: { defaultValue: {}, type: 'Object' },
  $authentication: { defaultValue: {}, type: 'SecureObject' },
};

function boilerplateIR(overrides: Partial<FlowIR> = {}): FlowIR {
  return {
    name: 'TestFlow',
    nodes: [
      {
        id: 'trg_1',
        type: 'trigger',
        name: 'manual',
        kind: 'http',
        inputs: { method: 'POST' },
      },
      {
        id: 'act_1',
        type: 'action',
        name: 'Compose',
        kind: 'compose',
        inputs: { value: 'hello' },
      },
    ] as FlowIR['nodes'],
    metadata: structuredClone(DEFAULT_METADATA),
    parameters: structuredClone(DEFAULT_PARAMETERS) as FlowIR['parameters'],
    connectionReferences: {},
    ...overrides,
  };
}

const skipConfig = { generator: { skipDefaultConstructor: true } };

describe('skipDefaultConstructor', () => {
  it('emits the boilerplate constructor when the flag is off (default)', () => {
    const code = generateNativeDslFromIR(boilerplateIR());
    assert.match(code, /constructor\(ctx: FlowContext\)/);
    assert.match(code, /\$authentication/);
  });

  it('omits the constructor for fully-default content when the flag is on', () => {
    const code = generateNativeDslFromIR(boilerplateIR(), { config: skipConfig });
    assert.doesNotMatch(code, /constructor\(/);
    assert.doesNotMatch(code, /ctx\.flow\./);
  });

  it('omits the constructor when only a subset of default fields is present', () => {
    const ir = boilerplateIR({ parameters: undefined, connectionReferences: undefined });
    const code = generateNativeDslFromIR(ir, { config: skipConfig });
    assert.doesNotMatch(code, /constructor\(/);
  });

  it('still omits the constructor when there is no constructor content at all', () => {
    const ir = boilerplateIR({
      metadata: undefined,
      parameters: undefined,
      connectionReferences: undefined,
    });
    const code = generateNativeDslFromIR(ir, { config: skipConfig });
    assert.doesNotMatch(code, /constructor\(/);
  });

  it('emits the full constructor when real connection references exist', () => {
    const ir = boilerplateIR({
      connectionReferences: {
        shared_sharepointonline: {
          apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
        },
      },
    });
    const code = generateNativeDslFromIR(ir, { config: skipConfig });
    assert.match(code, /constructor\(ctx: FlowContext\)/);
    assert.match(code, /shared_sharepointonline/);
    // All-or-nothing: default parts are still emitted alongside
    assert.match(code, /\$authentication/);
  });

  it('emits the full constructor when a non-default parameter exists', () => {
    const ir = boilerplateIR({
      parameters: {
        ...structuredClone(DEFAULT_PARAMETERS),
        MyEnvVar: { defaultValue: 'x', type: 'String' },
      } as FlowIR['parameters'],
    });
    const code = generateNativeDslFromIR(ir, { config: skipConfig });
    assert.match(code, /constructor\(ctx: FlowContext\)/);
    assert.match(code, /MyEnvVar/);
  });

  it('emits the full constructor when a default parameter has a non-default shape', () => {
    const ir = boilerplateIR({
      parameters: {
        $connections: { defaultValue: { some: 'value' }, type: 'Object' },
        $authentication: { defaultValue: {}, type: 'SecureObject' },
      } as FlowIR['parameters'],
    });
    const code = generateNativeDslFromIR(ir, { config: skipConfig });
    assert.match(code, /constructor\(ctx: FlowContext\)/);
  });

  it('emits the full constructor when metadata is non-default', () => {
    const ir = boilerplateIR({
      metadata: { ...structuredClone(DEFAULT_METADATA), contentVersion: '2.0.0.0' },
    });
    const code = generateNativeDslFromIR(ir, { config: skipConfig });
    assert.match(code, /constructor\(ctx: FlowContext\)/);
  });

  it('emits the full constructor when childFlows are present', () => {
    const ir = boilerplateIR({
      childFlows: {
        MyChild: { workflowId: '00000000-0000-0000-0000-000000000001' },
      } as FlowIR['childFlows'],
    });
    const code = generateNativeDslFromIR(ir, { config: skipConfig });
    assert.match(code, /constructor\(ctx: FlowContext\)/);
    assert.match(code, /childFlows/);
  });

  it('emits the full constructor when outputs are present', () => {
    const ir = boilerplateIR({ outputs: {} });
    const code = generateNativeDslFromIR(ir, { config: skipConfig });
    assert.match(code, /constructor\(ctx: FlowContext\)/);
  });

  it('emits the full constructor when workflowMetadata is present', () => {
    const ir = boilerplateIR({ workflowMetadata: { provisioningMethod: 'FromDefinition' } });
    const code = generateNativeDslFromIR(ir, { config: skipConfig });
    assert.match(code, /constructor\(ctx: FlowContext\)/);
  });

  it('emits the full constructor when staticResults are present', () => {
    const ir = boilerplateIR({ staticResults: { Compose0: { status: 'Succeeded' } } });
    const code = generateNativeDslFromIR(ir, { config: skipConfig });
    assert.match(code, /constructor\(ctx: FlowContext\)/);
  });
});
