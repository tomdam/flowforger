// Form-data functions against the shapes the cloud's Request trigger stores, measured by
// conformance/flows/formdata-urlencoded.ff.ts and formdata-multipart.ff.ts (same request bodies).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evalExpression } from '../expressions.js';
import { requestTriggerOutputs } from '../trigger-outputs.js';
import type { RunContext } from '../index.js';

function makeContext(opts: { actions?: Record<string, any>; triggerData?: any } = {}): RunContext {
  const actions = new Map<string, any>();
  for (const [k, v] of Object.entries(opts.actions ?? {})) {
    actions.set(k, { status: 'Succeeded', outputs: v });
  }
  return {
    variables: {},
    actions,
    triggerData: opts.triggerData,
    workflowName: 'test',
    parameters: {},
    now: () => new Date('2026-01-01T00:00:00Z'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
    secrets: () => undefined,
    connector: () => { throw new Error('no connector'); },
  };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const FORM = 'a=1&b=x&b=2&c=x+y%2Bz&sp%20ace=%C3%A4&empty=';
const BOUNDARY = 'FfcBoundary';
const MULTIPART = [
  `--${BOUNDARY}`, 'Content-Disposition: form-data; name="title"', '', 'Hello ä',
  `--${BOUNDARY}`, 'Content-Disposition: form-data; name="file"; filename="a.txt"', 'Content-Type: text/plain', '', 'file content',
  `--${BOUNDARY}`, 'Content-Disposition: form-data; name="tag"', '', 'one',
  `--${BOUNDARY}`, 'Content-Disposition: form-data; name="tag"', '', 'two',
  `--${BOUNDARY}--`, '',
].join('\r\n');
const MULTIPART_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

const formTrigger = () => requestTriggerOutputs('application/x-www-form-urlencoded', bytes(FORM));
const multipartTrigger = () => requestTriggerOutputs(MULTIPART_TYPE, bytes(MULTIPART));
const octet = (text: string) => ({ '$content-type': 'application/octet-stream', '$content': Buffer.from(text).toString('base64') });

describe('requestTriggerOutputs', () => {
  it('stores a form post as binary content with its fields in $formdata', () => {
    assert.deepEqual(formTrigger(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: {
        '$content-type': 'application/x-www-form-urlencoded',
        '$content': Buffer.from(FORM).toString('base64'),
        '$formdata': [
          { key: 'a', value: '1' },
          { key: 'b', value: 'x' },
          { key: 'b', value: '2' },
          { key: 'c', value: 'x y+z' },
          { key: 'sp ace', value: 'ä' },
          { key: 'empty', value: '' },
        ],
      },
    });
  });

  it('stores multipart data with its parts: text/* bodies as strings, others as binary', () => {
    const { body } = multipartTrigger() as any;
    assert.equal(body['$content-type'], MULTIPART_TYPE);
    assert.equal(body['$content'], Buffer.from(MULTIPART).toString('base64'));
    assert.deepEqual(body['$multipart'], [
      { headers: { 'Content-Disposition': 'form-data; name="title"', 'Content-Length': '8' }, body: octet('Hello ä') },
      {
        headers: { 'Content-Disposition': 'form-data; name="file"; filename="a.txt"', 'Content-Type': 'text/plain', 'Content-Length': '12' },
        body: 'file content',
      },
      { headers: { 'Content-Disposition': 'form-data; name="tag"', 'Content-Length': '3' }, body: octet('one') },
      { headers: { 'Content-Disposition': 'form-data; name="tag"', 'Content-Length': '3' }, body: octet('two') },
    ]);
  });

  it('parses JSON and keeps other content as binary', () => {
    assert.deepEqual(requestTriggerOutputs('application/json', bytes('{"a":1}')).body, { a: 1 });
    assert.deepEqual(requestTriggerOutputs('image/png', new Uint8Array([0x89, 0x50])).body, { '$content-type': 'image/png', '$content': 'iVA=' });
  });

  it('reads as the raw text in string()', () => {
    assert.equal(evalExpression(`@string(triggerBody())`, makeContext({ triggerData: formTrigger() })), FORM);
  });
});

describe('triggerFormDataValue / triggerFormDataMultiValues (form post)', () => {
  const ctx = () => makeContext({ triggerData: formTrigger() });

  it('reads decoded fields', () => {
    assert.equal(evalExpression(`@triggerFormDataValue('a')`, ctx()), '1');
    assert.equal(evalExpression(`@triggerFormDataValue('c')`, ctx()), 'x y+z');
    assert.equal(evalExpression(`@triggerFormDataValue('sp ace')`, ctx()), 'ä');
    assert.equal(evalExpression(`@triggerFormDataValue('empty')`, ctx()), '');
    assert.equal(evalExpression(`@triggerFormDataValue('missing')`, ctx()), null);
    assert.deepEqual(evalExpression(`@triggerFormDataMultiValues('b')`, ctx()), ['x', '2']);
    assert.deepEqual(evalExpression(`@triggerFormDataMultiValues('a')`, ctx()), ['1']);
    assert.deepEqual(evalExpression(`@triggerFormDataMultiValues('missing')`, ctx()), []);
  });

  it('refuses a field sent twice', () => {
    assert.throws(
      () => evalExpression(`@triggerFormDataValue('b')`, ctx()),
      { message: "The template language function 'triggerFormDataValue' failed to retrieve formdata contents from outputs. There are more than one items matching the field name 'b'." },
    );
  });

  it('refuses a body that is not form data (the content type comes from the headers)', () => {
    assert.throws(
      () => evalExpression(`@triggerFormDataValue('a')`, makeContext({ triggerData: { headers: { 'Content-Type': 'application/json' }, body: { a: 1 } } })),
      /the provided content type is 'application\/json'\.$/,
    );
  });
});

describe('triggerMultipartBody / triggerFormDataValue (multipart)', () => {
  const ctx = () => makeContext({ triggerData: multipartTrigger() });

  it('returns a part body by index', () => {
    assert.deepEqual(evalExpression(`@triggerMultipartBody(0)`, ctx()), octet('Hello ä'));
    assert.equal(evalExpression(`@triggerMultipartBody(1)`, ctx()), 'file content');
    assert.equal(evalExpression(`@string(triggerMultipartBody(0))`, ctx()), 'Hello ä');
  });

  it('refuses an index past the last part', () => {
    assert.throws(
      () => evalExpression(`@triggerMultipartBody(9)`, ctx()),
      { message: "The template language function 'triggerMultipartBody' failed to retrieve multipart contents from outputs. The index value '9' exceeds the number of multipart contents '4' in the outputs." },
    );
  });

  it('reads parts by their Content-Disposition name', () => {
    assert.deepEqual(evalExpression(`@triggerFormDataValue('title')`, ctx()), octet('Hello ä'));
    assert.equal(evalExpression(`@triggerFormDataValue('file')`, ctx()), 'file content');
    assert.deepEqual(evalExpression(`@triggerFormDataMultiValues('tag')`, ctx()), [octet('one'), octet('two')]);
    assert.equal(evalExpression(`@triggerFormDataValue('missing')`, ctx()), null);
    assert.throws(() => evalExpression(`@triggerFormDataValue('tag')`, ctx()), /more than one items matching the field name 'tag'/);
  });
});

describe('formDataValue / formDataMultiValues / multipartBody (action outputs)', () => {
  it('read an HTTP-shaped output ({ headers, body })', () => {
    const ctx = makeContext({ actions: { Form: formTrigger(), Multi: multipartTrigger() } });
    assert.equal(evalExpression(`@formDataValue('Form', 'a')`, ctx), '1');
    assert.deepEqual(evalExpression(`@formDataMultiValues('Form', 'b')`, ctx), ['x', '2']);
    assert.equal(evalExpression(`@multipartBody('Multi', 1)`, ctx), 'file content');
    assert.deepEqual(evalExpression(`@formDataValue('Multi', 'title')`, ctx), octet('Hello ä'));
  });

  it('refuse a Compose of the form body: it has no Content-Type header', () => {
    const ctx = makeContext({ actions: { Compose: formTrigger().body, ComposeMulti: multipartTrigger().body } });
    assert.throws(
      () => evalExpression(`@formDataValue('Compose', 'a')`, ctx),
      { message: "The template language function 'formDataValue' failed to retrieve formdata contents from outputs. The output content is not a valid form data content. Supported form data content types are 'multipart/form-data' and 'application/x-www-form-urlencoded' and the provided content type is '<null>'." },
    );
    assert.throws(
      () => evalExpression(`@multipartBody('ComposeMulti', 0)`, ctx),
      { message: "The template language function 'multipartBody' failed to retrieve multipart contents from outputs. The supported multipart content type is 'multipart/*' and the provided content type is '<null>'. " },
    );
    // the parsed fields are still there to read
    assert.equal(evalExpression(`@length(outputs('ComposeMulti')?['$multipart'])`, ctx), 4);
  });
});
