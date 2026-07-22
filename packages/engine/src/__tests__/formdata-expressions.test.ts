import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evalExpression } from '../expressions.js';
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

describe('formDataValue (action)', () => {
  it('reads a single string value from outputs.body', () => {
    const ctx = makeContext({ actions: { ParseForm: { body: { name: 'alice', age: '30' } } } });
    assert.equal(evalExpression(`@formDataValue('ParseForm', 'name')`, ctx), 'alice');
  });

  it('reads from outputs directly when there is no body wrapper', () => {
    const ctx = makeContext({ actions: { Compose: { foo: 'bar' } } });
    assert.equal(evalExpression(`@formDataValue('Compose', 'foo')`, ctx), 'bar');
  });

  it('unwraps a single-element array', () => {
    const ctx = makeContext({ actions: { Form: { body: { tag: ['only'] } } } });
    assert.equal(evalExpression(`@formDataValue('Form', 'tag')`, ctx), 'only');
  });

  it('throws when key has multiple values', () => {
    const ctx = makeContext({ actions: { Form: { body: { tag: ['a', 'b'] } } } });
    assert.throws(() => evalExpression(`@formDataValue('Form', 'tag')`, ctx), /multiple values/);
  });

  it('returns undefined when key is missing', () => {
    const ctx = makeContext({ actions: { Form: { body: {} } } });
    assert.equal(evalExpression(`@formDataValue('Form', 'missing')`, ctx), undefined);
  });

  it('returns undefined when action is not found', () => {
    const ctx = makeContext({ actions: {} });
    assert.equal(evalExpression(`@formDataValue('Nope', 'x')`, ctx), undefined);
  });
});

describe('formDataMultiValues (action)', () => {
  it('returns array unchanged when value is already an array', () => {
    const ctx = makeContext({ actions: { Form: { body: { tag: ['a', 'b', 'c'] } } } });
    assert.deepEqual(evalExpression(`@formDataMultiValues('Form', 'tag')`, ctx), ['a', 'b', 'c']);
  });

  it('wraps a single string value in an array', () => {
    const ctx = makeContext({ actions: { Form: { body: { tag: 'only' } } } });
    assert.deepEqual(evalExpression(`@formDataMultiValues('Form', 'tag')`, ctx), ['only']);
  });

  it('returns empty array for missing key', () => {
    const ctx = makeContext({ actions: { Form: { body: {} } } });
    assert.deepEqual(evalExpression(`@formDataMultiValues('Form', 'missing')`, ctx), []);
  });
});

describe('multipartBody (action)', () => {
  it('returns the body of part at index from $multipart', () => {
    const ctx = makeContext({
      actions: { Upload: { body: { $multipart: [{ body: 'first' }, { body: 'second' }] } } },
    });
    assert.equal(evalExpression(`@multipartBody('Upload', 0)`, ctx), 'first');
    assert.equal(evalExpression(`@multipartBody('Upload', 1)`, ctx), 'second');
  });

  it('also reads from a `parts` array', () => {
    const ctx = makeContext({
      actions: { Upload: { body: { parts: [{ body: 'A' }, { body: 'B' }] } } },
    });
    assert.equal(evalExpression(`@multipartBody('Upload', 1)`, ctx), 'B');
  });

  it('returns binary objects as-is from the part body', () => {
    const ctx = makeContext({
      actions: { Upload: { body: { $multipart: [{ body: { '$content-type': 'image/png', '$content': 'iVBORw==' } }] } } },
    });
    assert.deepEqual(evalExpression(`@multipartBody('Upload', 0)`, ctx), { '$content-type': 'image/png', '$content': 'iVBORw==' });
  });

  it('returns undefined when no parts', () => {
    const ctx = makeContext({ actions: { Upload: { body: 'plain text' } } });
    assert.equal(evalExpression(`@multipartBody('Upload', 0)`, ctx), undefined);
  });
});

describe('triggerFormDataValue / triggerFormDataMultiValues', () => {
  it('reads from triggerData.body', () => {
    const ctx = makeContext({ triggerData: { body: { user: 'bob', tag: ['x', 'y'] } } });
    assert.equal(evalExpression(`@triggerFormDataValue('user')`, ctx), 'bob');
    assert.deepEqual(evalExpression(`@triggerFormDataMultiValues('tag')`, ctx), ['x', 'y']);
  });

  it('reads from triggerData directly when no body wrapper', () => {
    const ctx = makeContext({ triggerData: { foo: 'bar' } });
    assert.equal(evalExpression(`@triggerFormDataValue('foo')`, ctx), 'bar');
  });

  it('throws on multi-value with triggerFormDataValue', () => {
    const ctx = makeContext({ triggerData: { body: { tag: ['a', 'b'] } } });
    assert.throws(() => evalExpression(`@triggerFormDataValue('tag')`, ctx), /multiple values/);
  });

  it('triggerFormDataMultiValues returns empty array for missing key', () => {
    const ctx = makeContext({ triggerData: { body: {} } });
    assert.deepEqual(evalExpression(`@triggerFormDataMultiValues('missing')`, ctx), []);
  });
});

describe('triggerMultipartBody', () => {
  it('returns part body by index', () => {
    const ctx = makeContext({
      triggerData: { body: { $multipart: [{ body: 'meta' }, { body: 'file' }] } },
    });
    assert.equal(evalExpression(`@triggerMultipartBody(0)`, ctx), 'meta');
    assert.equal(evalExpression(`@triggerMultipartBody(1)`, ctx), 'file');
  });

  it('returns undefined when triggerData has no parts', () => {
    const ctx = makeContext({ triggerData: { body: 'plain' } });
    assert.equal(evalExpression(`@triggerMultipartBody(0)`, ctx), undefined);
  });
});
