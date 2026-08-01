import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setFlowWorkflowIdInSource } from '../src/workflow-id-writer.js';
import { transformCode } from '../src/transformer/index.js';

const GUID = '11111111-2222-3333-4444-555555555555';

const SHORT_FORM = `import { Flow, ManualTrigger } from '@flowforger/dsl-native';

// A hand-written comment that must survive
@Flow("My Flow")
export class MyFlow {
  @ManualTrigger()
  trigger() {}
}
`;

const OBJECT_FORM = `import { Flow } from '@flowforger/dsl-native';

@Flow({ name: "My Flow" })
export class MyFlow {}
`;

const EXISTING_ID = `import { Flow } from '@flowforger/dsl-native';

@Flow({ name: "My Flow", workflowId: "00000000-0000-0000-0000-000000000000" })
export class MyFlow {}
`;

describe('setFlowWorkflowIdInSource', () => {
  it('converts the short string form to the object form with a workflowId', () => {
    const result = setFlowWorkflowIdInSource(SHORT_FORM, GUID);

    assert.ok(result, 'expected a rewritten source');
    assert.match(result, /workflowId:\s*"11111111-2222-3333-4444-555555555555"/);
    assert.match(result, /name:\s*"My Flow"/);
  });

  it('preserves comments and unrelated code', () => {
    const result = setFlowWorkflowIdInSource(SHORT_FORM, GUID)!;

    assert.ok(result.includes('// A hand-written comment that must survive'));
    assert.ok(result.includes('@ManualTrigger()'));
    assert.ok(result.includes("import { Flow, ManualTrigger } from '@flowforger/dsl-native';"));
  });

  it('adds workflowId to the object form', () => {
    const result = setFlowWorkflowIdInSource(OBJECT_FORM, GUID);

    assert.ok(result);
    assert.match(result, /workflowId:\s*"11111111-2222-3333-4444-555555555555"/);
    assert.match(result, /name:\s*"My Flow"/);
  });

  it('overwrites an existing workflowId', () => {
    const result = setFlowWorkflowIdInSource(EXISTING_ID, GUID)!;

    assert.match(result, /workflowId:\s*"11111111-2222-3333-4444-555555555555"/);
    assert.ok(!result.includes('00000000-0000-0000-0000-000000000000'));
  });

  it('returns null when there is no @Flow decorator', () => {
    assert.equal(setFlowWorkflowIdInSource('export class NotAFlow {}', GUID), null);
  });

  it('returns null when @Flow has no arguments', () => {
    assert.equal(setFlowWorkflowIdInSource('@Flow()\nexport class F {}', GUID), null);
  });

  it('returns null when the @Flow argument is a computed expression it cannot edit', () => {
    assert.equal(setFlowWorkflowIdInSource('@Flow(NAME_CONST)\nexport class F {}', GUID), null);
  });

  it('round-trips through transformCode: name and workflowId are both readable back', () => {
    // Needs at least one trigger + action for transformCode to produce a flow;
    // SHORT_FORM/OBJECT_FORM above are decorator-only fixtures with neither.
    const RUNNABLE_SHORT_FORM = `import { Flow, HttpTrigger, Action } from '@flowforger/dsl-native';

@Flow("My Flow")
export class MyFlow {
  @HttpTrigger()
  trigger() {}

  @Action()
  doThing() {}
}
`;
    const RUNNABLE_OBJECT_FORM = `import { Flow, HttpTrigger, Action } from '@flowforger/dsl-native';

@Flow({ name: "My Flow" })
export class MyFlow {
  @HttpTrigger()
  trigger() {}

  @Action()
  doThing() {}
}
`;

    const shortFormResult = setFlowWorkflowIdInSource(RUNNABLE_SHORT_FORM, GUID)!;
    const shortFormIr = transformCode(shortFormResult);
    assert.equal(shortFormIr.name, 'My Flow');
    assert.equal(shortFormIr.workflowId, GUID);

    const objectFormResult = setFlowWorkflowIdInSource(RUNNABLE_OBJECT_FORM, GUID)!;
    const objectFormIr = transformCode(objectFormResult);
    assert.equal(objectFormIr.name, 'My Flow');
    assert.equal(objectFormIr.workflowId, GUID);
  });
});

describe('setFlowWorkflowIdInSource — line endings and BOM', () => {
  // Both fixtures spell their line endings with explicit escapes rather than
  // relying on this file's own bytes: git's autocrlf would rewrite a template
  // literal's newlines on checkout and silently invert what these tests assert.
  const CRLF_OBJECT_FORM =
    "import { Flow } from '@flowforger/dsl-native';\r\n\r\n@Flow({\r\n  name: \"My Flow\"\r\n})\r\nexport class MyFlow {}\r\n";
  const LF_OBJECT_FORM =
    "import { Flow } from '@flowforger/dsl-native';\n\n@Flow({\n  name: \"My Flow\"\n})\nexport class MyFlow {}\n";

  it('preserves CRLF line endings throughout the rewritten file', () => {
    const result = setFlowWorkflowIdInSource(CRLF_OBJECT_FORM, GUID)!;
    assert.ok(result, 'expected a rewritten source');
    assert.match(result, /workflowId:\s*"11111111-2222-3333-4444-555555555555"/);
    assert.ok(!/(?<!\r)\n/.test(result), 'no bare LF should appear in a CRLF file');
  });

  it('preserves LF line endings for an LF source (no CRLF introduced)', () => {
    const result = setFlowWorkflowIdInSource(LF_OBJECT_FORM, GUID)!;
    assert.ok(!result.includes('\r\n'), 'no CRLF should appear in an LF file');
  });

  it('preserves a UTF-8 BOM on the rewritten source', () => {
    const withBom = '﻿' + LF_OBJECT_FORM;
    const result = setFlowWorkflowIdInSource(withBom, GUID)!;
    assert.equal(result.charCodeAt(0), 0xfeff, 'BOM must survive the rewrite');
    assert.match(result, /workflowId:\s*"11111111-2222-3333-4444-555555555555"/);
  });

  it('does not add a BOM to a source that did not have one', () => {
    const result = setFlowWorkflowIdInSource(OBJECT_FORM, GUID)!;
    assert.notEqual(result.charCodeAt(0), 0xfeff);
  });
});
