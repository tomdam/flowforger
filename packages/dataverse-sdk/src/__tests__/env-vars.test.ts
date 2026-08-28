import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DataverseClient,
  collectEnvVarParameters,
  resolveEnvVarValues,
  buildParameterOverrides,
  fetchEnvVarResolution,
  type EnvironmentVariableDefinition,
  type EnvironmentVariableValue,
} from '../index.js';

const flow = {
  name: 'Test',
  parameters: {
    'Site URL (cr123_siteUrl)': {
      type: 'String',
      defaultValue: 'https://design-time-default',
      metadata: { schemaName: 'cr123_siteUrl' },
    },
    'Max Items (cr123_maxItems)': {
      type: 'String',
      defaultValue: '10',
      metadata: { schemaName: 'cr123_maxItems' },
    },
    plainParam: { type: 'String', defaultValue: 'not-an-env-var' },
  },
};

function def(
  overrides: Partial<EnvironmentVariableDefinition> & { schemaname: string }
): EnvironmentVariableDefinition {
  return {
    environmentvariabledefinitionid: `def-${overrides.schemaname}`,
    displayname: overrides.schemaname,
    type: 100000000,
    ...overrides,
  };
}

function val(definitionId: string, value: string): EnvironmentVariableValue {
  return {
    environmentvariablevalueid: `val-${definitionId}`,
    schemaname: '',
    value,
    environmentvariabledefinitionid: definitionId,
  };
}

describe('collectEnvVarParameters', () => {
  it('returns only parameters with a schemaName binding', () => {
    assert.deepEqual(collectEnvVarParameters(flow), [
      { parameterName: 'Site URL (cr123_siteUrl)', schemaName: 'cr123_siteUrl' },
      { parameterName: 'Max Items (cr123_maxItems)', schemaName: 'cr123_maxItems' },
    ]);
  });

  it('returns empty for a flow without parameters', () => {
    assert.deepEqual(collectEnvVarParameters({ name: 'x' }), []);
  });
});

describe('resolveEnvVarValues', () => {
  const bindings = collectEnvVarParameters(flow);

  it('prefers the current value record over the definition default', () => {
    const defs = [def({ schemaname: 'cr123_siteUrl', defaultvalue: 'https://default' })];
    const values = [val('def-cr123_siteUrl', 'https://actual')];
    const [resolved] = resolveEnvVarValues([bindings[0]], defs, values);
    assert.equal(resolved.value, 'https://actual');
    assert.equal(resolved.source, 'value');
  });

  it('falls back to the definition current default when no value record exists', () => {
    const defs = [def({ schemaname: 'cr123_siteUrl', defaultvalue: 'https://current-default' })];
    const [resolved] = resolveEnvVarValues([bindings[0]], defs, []);
    assert.equal(resolved.value, 'https://current-default');
    assert.equal(resolved.source, 'default');
  });

  it('treats an empty value record as absent and falls back to the default', () => {
    const defs = [def({ schemaname: 'cr123_siteUrl', defaultvalue: 'https://current-default' })];
    const [resolved] = resolveEnvVarValues([bindings[0]], defs, [val('def-cr123_siteUrl', '')]);
    assert.equal(resolved.value, 'https://current-default');
    assert.equal(resolved.source, 'default');
  });

  it('marks unresolved when no matching definition exists', () => {
    const [resolved] = resolveEnvVarValues([bindings[0]], [], []);
    assert.equal(resolved.source, 'unresolved');
    assert.equal(resolved.value, undefined);
  });

  it('marks unresolved when the definition has neither value nor default', () => {
    const [resolved] = resolveEnvVarValues([bindings[0]], [def({ schemaname: 'cr123_siteUrl' })], []);
    assert.equal(resolved.source, 'unresolved');
  });

  it('matches schema names case-insensitively', () => {
    const defs = [def({ schemaname: 'CR123_SiteURL', defaultvalue: 'https://cased' })];
    const [resolved] = resolveEnvVarValues([bindings[0]], defs, []);
    assert.equal(resolved.value, 'https://cased');
  });

  it('coerces number-typed values', () => {
    const defs = [def({ schemaname: 'cr123_maxItems', type: 100000001 })];
    const [resolved] = resolveEnvVarValues([bindings[1]], defs, [val('def-cr123_maxItems', '42')]);
    assert.equal(resolved.value, 42);
  });

  it('coerces boolean-typed values (true/false and yes/no forms)', () => {
    const defs = [def({ schemaname: 'cr123_maxItems', type: 100000002 })];
    assert.equal(resolveEnvVarValues([bindings[1]], defs, [val('def-cr123_maxItems', 'true')])[0].value, true);
    assert.equal(resolveEnvVarValues([bindings[1]], defs, [val('def-cr123_maxItems', 'yes')])[0].value, true);
    assert.equal(resolveEnvVarValues([bindings[1]], defs, [val('def-cr123_maxItems', 'false')])[0].value, false);
    assert.equal(resolveEnvVarValues([bindings[1]], defs, [val('def-cr123_maxItems', 'no')])[0].value, false);
  });

  it('parses JSON-typed values and keeps the raw string when parsing fails', () => {
    const defs = [def({ schemaname: 'cr123_maxItems', type: 100000003 })];
    assert.deepEqual(
      resolveEnvVarValues([bindings[1]], defs, [val('def-cr123_maxItems', '{"a":1}')])[0].value,
      { a: 1 }
    );
    assert.equal(
      resolveEnvVarValues([bindings[1]], defs, [val('def-cr123_maxItems', 'not-json')])[0].value,
      'not-json'
    );
  });

  it('carries the definition display name', () => {
    const defs = [def({ schemaname: 'cr123_siteUrl', displayname: 'Site URL', defaultvalue: 'x' })];
    assert.equal(resolveEnvVarValues([bindings[0]], defs, [])[0].displayName, 'Site URL');
  });
});

describe('buildParameterOverrides', () => {
  it('maps resolved entries by parameter name and skips unresolved ones', () => {
    const overrides = buildParameterOverrides([
      { parameterName: 'A (s_a)', schemaName: 's_a', value: 'live', source: 'value' },
      { parameterName: 'B (s_b)', schemaName: 's_b', value: 'def', source: 'default' },
      { parameterName: 'C (s_c)', schemaName: 's_c', source: 'unresolved' },
    ]);
    assert.deepEqual(overrides, { 'A (s_a)': 'live', 'B (s_b)': 'def' });
  });
});

describe('fetchEnvVarResolution', () => {
  it('returns null without calling the client when the flow has no env var parameters', async () => {
    let calls = 0;
    const client = {
      listEnvironmentVariableDefinitions: async () => {
        calls++;
        return [];
      },
      listEnvironmentVariableValues: async () => {
        calls++;
        return [];
      },
    };
    const result = await fetchEnvVarResolution({ name: 'x', parameters: { p: {} } }, client);
    assert.equal(result, null);
    assert.equal(calls, 0);
  });

  it('fetches definitions and values and returns resolution plus overrides', async () => {
    const client = {
      listEnvironmentVariableDefinitions: async () => [
        def({ schemaname: 'cr123_siteUrl', defaultvalue: 'https://default' }),
        def({ schemaname: 'cr123_maxItems', type: 100000001, defaultvalue: '5' }),
      ],
      listEnvironmentVariableValues: async () => [val('def-cr123_siteUrl', 'https://actual')],
    };
    const result = await fetchEnvVarResolution(flow, client);
    assert.ok(result);
    assert.deepEqual(result!.overrides, {
      'Site URL (cr123_siteUrl)': 'https://actual',
      'Max Items (cr123_maxItems)': 5,
    });
  });
});

describe('DataverseClient env var endpoints', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(body: unknown): { calls: string[] } {
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    return { calls };
  }

  it('listEnvironmentVariableDefinitions queries the definitions entity set', async () => {
    const { calls } = stubFetch({ value: [{ schemaname: 's', environmentvariabledefinitionid: 'id' }] });
    const client = new DataverseClient({ baseUrl: 'https://org.crm.dynamics.com', token: 't' });
    const defs = await client.listEnvironmentVariableDefinitions();
    assert.equal(defs.length, 1);
    assert.match(calls[0], /\/api\/data\/v9\.2\/environmentvariabledefinitions\?/);
  });

  it('listEnvironmentVariableValues maps the definition id lookup field', async () => {
    const { calls } = stubFetch({
      value: [
        {
          environmentvariablevalueid: 'v1',
          schemaname: 's',
          value: 'x',
          _environmentvariabledefinitionid_value: 'def-1',
        },
      ],
    });
    const client = new DataverseClient({ baseUrl: 'https://org.crm.dynamics.com', token: 't' });
    const values = await client.listEnvironmentVariableValues();
    assert.equal(values[0].environmentvariabledefinitionid, 'def-1');
    assert.match(calls[0], /\/api\/data\/v9\.2\/environmentvariablevalues\?/);
  });
});
