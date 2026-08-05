import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowForgerConfig } from '@flowforger/ir';
import { checkParity } from '../parity.js';

const config: FlowForgerConfig = {};

/**
 * Minimal Dataverse-format flow with one OpenApiConnection action.
 * `auth` controls the action's inputs.authentication: undefined omits the
 * property (older portal exports), any other value is emitted verbatim.
 */
function connectorFlow(auth?: any): any {
  const inputs: any = {
    parameters: {
      dataset: 'https://contoso.sharepoint.com/sites/Test',
      'parameters/method': 'GET',
      'parameters/uri': '_api/web/lists',
    },
    host: {
      apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
      operationId: 'HttpRequest',
      connectionName: 'shared_sharepointonline',
    },
  };
  if (auth !== undefined) {
    inputs.authentication = auth;
  }
  return {
    properties: {
      connectionReferences: {
        shared_sharepointonline: {
          runtimeSource: 'embedded',
          connection: { connectionReferenceLogicalName: 'new_sharedsharepointonline_test' },
          api: { name: 'shared_sharepointonline' },
        },
      },
      definition: {
        $schema:
          'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        parameters: {
          $authentication: { defaultValue: {}, type: 'SecureObject' },
          $connections: { defaultValue: {}, type: 'Object' },
        },
        triggers: {
          manual: {
            type: 'Request',
            kind: 'Http',
            inputs: { schema: { type: 'object', properties: {} } },
          },
        },
        actions: {
          Call_SharePoint: { runAfter: {}, type: 'OpenApiConnection', inputs },
        },
      },
    },
    schemaVersion: '1.0.0.0',
  };
}

/**
 * Minimal flow with an If condition whose comparison operand is the given
 * literal — either the expression string "@false"/"@true" or a boolean.
 */
function conditionFlow(operand: any): any {
  return expressionFlow({ and: [{ equals: ["@variables('flag')", operand] }] });
}

/** Minimal flow with an If condition using the given raw expression object. */
function expressionFlow(expression: any): any {
  return {
    properties: {
      definition: {
        $schema:
          'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        parameters: {
          $authentication: { defaultValue: {}, type: 'SecureObject' },
          $connections: { defaultValue: {}, type: 'Object' },
        },
        triggers: {
          manual: {
            type: 'Request',
            kind: 'Http',
            inputs: { schema: { type: 'object', properties: {} } },
          },
        },
        actions: {
          Init_flag: {
            runAfter: {},
            type: 'InitializeVariable',
            inputs: { variables: [{ name: 'flag', type: 'boolean', value: false }] },
          },
          My_Special_Check: {
            runAfter: { Init_flag: ['Succeeded'] },
            type: 'If',
            expression,
            actions: {
              Mark_done: {
                runAfter: {},
                type: 'Compose',
                inputs: 'done',
              },
            },
          },
        },
      },
    },
    schemaVersion: '1.0.0.0',
  };
}

describe('checkParity authentication normalization', () => {
  it('passes when the original omits the default inputs.authentication the emitter re-injects', () => {
    const result = checkParity(connectorFlow(), { flowName: 'AuthTest', config });
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });

  it('still passes when the original carries the default inputs.authentication explicitly', () => {
    const result = checkParity(connectorFlow("@parameters('$authentication')"), {
      flowName: 'AuthTest',
      config,
    });
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });
});

describe('checkParity @true/@false normalization', () => {
  it('passes when the original writes the condition operand as "@false"', () => {
    const result = checkParity(conditionFlow('@false'), { flowName: 'BoolTest', config });
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });

  it('passes when the original writes the condition operand as "@true"', () => {
    const result = checkParity(conditionFlow('@true'), { flowName: 'BoolTest', config });
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });

  it('passes when the original already uses a boolean literal', () => {
    const result = checkParity(conditionFlow(false), { flowName: 'BoolTest', config });
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });
});

describe('checkParity boolean expression canonicalization', () => {
  it('passes when the original wraps a single clause in or: [...]', () => {
    const result = checkParity(
      expressionFlow({ or: [{ equals: ["@variables('flag')", true] }] }),
      { flowName: 'OrWrapTest', config }
    );
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });

  it('passes when the original nests an and inside an and', () => {
    const result = checkParity(
      expressionFlow({
        and: [
          {
            and: [
              { equals: ["@variables('flag')", true] },
              { equals: ["@variables('flag')", false] },
            ],
          },
        ],
      }),
      { flowName: 'NestedAndTest', config }
    );
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });

  it('still fails when a multi-clause or would become an and', () => {
    // or with TWO clauses is NOT equivalent to and with the same clauses —
    // canonicalization must not collapse this distinction. The round-trip
    // preserves multi-clause or correctly, so parity passes; this guards that
    // the or shape survives (would fail if canonicalization merged or into and).
    const result = checkParity(
      expressionFlow({
        or: [
          { equals: ["@variables('flag')", true] },
          { equals: ["@variables('flag')", false] },
        ],
      }),
      { flowName: 'MultiOrTest', config }
    );
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });
});

describe('checkParity literal condition operands', () => {
  // Conditions whose operands are @-prefixed literal expressions (@0, @'',
  // @'text') or a whole-string @{...} interpolation. These previously failed
  // to parse in the generator, whose fallback comment broke the JSDoc @action
  // association and lost the If action's name.
  it('preserves the If action name with a nested @0 operand', () => {
    const result = checkParity(
      expressionFlow({ equals: ["@length(variables('flag'))", '@0'] }),
      { flowName: 'AtNumberTest', config }
    );
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });

  it("preserves the If action name with a nested @'' operand", () => {
    const result = checkParity(
      expressionFlow({ equals: ["@variables('flag')", "@''"] }),
      { flowName: 'AtEmptyStringTest', config }
    );
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });

  it("preserves the If action name with a nested @'text' operand", () => {
    const result = checkParity(
      expressionFlow({ equals: ["@variables('flag')", "@'Submitted'"] }),
      { flowName: 'AtStringTest', config }
    );
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });

  it('preserves the If action name with a whole-string @{...} operand', () => {
    const result = checkParity(
      expressionFlow({
        or: [
          { equals: ["@{outputs('Init_flag')?['body/x']}", 'True'] },
          { equals: ["@variables('flag')", 'Failed'] },
        ],
      }),
      { flowName: 'BracedOperandTest', config }
    );
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });
});

describe('checkParity bare-literal template segments', () => {
  it('round-trips a @{2026} template segment without gaining an inner @', () => {
    const flow = expressionFlow({ and: [{ equals: ["@variables('flag')", true] }] });
    flow.properties.definition.actions.Call_API = {
      runAfter: { My_Special_Check: ['Succeeded'] },
      type: 'Http',
      inputs: {
        method: 'GET',
        uri: "https://date.nager.at/api/v3/publicholidays/@{2026}/@{variables('flag')}",
      },
    };
    const result = checkParity(flow, { flowName: 'TemplateLiteralTest', config });
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });
});

describe('checkParity $connections parameter normalization', () => {
  it('passes when the original omits the default $connections parameter the emitter re-injects', () => {
    const flow = expressionFlow({ and: [{ equals: ["@variables('flag')", true] }] });
    delete flow.properties.definition.parameters.$connections;
    const result = checkParity(flow, { flowName: 'ConnectionsTest', config });
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });
});

describe('checkParity expression keyword case normalization', () => {
  it('passes when the original writes the keyword as capitalized True', () => {
    const result = checkParity(
      expressionFlow({ and: [{ equals: ["@if(equals(variables('flag'), True), 1, 2)", 1] }] }),
      { flowName: 'KeywordCaseTest', config }
    );
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });
});

describe('checkParity description whitespace normalization', () => {
  it('passes when the original description has a trailing space before an embedded newline', () => {
    const flow = expressionFlow({ and: [{ equals: ["@variables('flag')", true] }] });
    flow.properties.definition.actions.Init_flag.description =
      'Ignore if \nsecond line';
    const result = checkParity(flow, { flowName: 'DescWhitespaceTest', config });
    assert.equal(
      result.ok,
      true,
      `expected parity ok, got diffs: ${JSON.stringify(result.differences)}`
    );
  });
});
