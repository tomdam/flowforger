import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toCloudFileContent } from '../index.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('toCloudFileContent', () => {
  it('keeps binary content as the Logic Apps envelope', () => {
    const content = b64('%PDF-1.7');
    assert.deepEqual(toCloudFileContent(content, 'application/pdf'), {
      '$content-type': 'application/pdf',
      $content: content,
    });
  });

  it('keeps the content type as given in the envelope (parameters included)', () => {
    const content = b64('x');
    assert.deepEqual(toCloudFileContent(content, 'application/octet-stream; foo=bar'), {
      '$content-type': 'application/octet-stream; foo=bar',
      $content: content,
    });
  });

  it('decodes text/* as UTF-8 text', () => {
    assert.equal(toCloudFileContent(b64('héllo'), 'text/plain; charset=utf-8'), 'héllo');
  });

  it('matches the media type case-insensitively', () => {
    assert.equal(toCloudFileContent(b64('<a/>'), 'TEXT/XML'), '<a/>');
  });

  it('parses application/json', () => {
    assert.deepEqual(toCloudFileContent(b64('{"a":[1,2]}'), 'application/json'), { a: [1, 2] });
  });

  it('falls back to text when application/json does not parse', () => {
    assert.equal(toCloudFileContent(b64('not json'), 'application/json'), 'not json');
  });
});
