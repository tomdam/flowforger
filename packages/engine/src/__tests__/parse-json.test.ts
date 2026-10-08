import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../index.js';
import { parseJsonAction } from '../parse-json.js';
import { JsonReaderError, nodeToValue, readNewtonsoftJson } from '../newtonsoft-reader.js';
import { validateJsonSchema } from '../json-schema.js';
import type { FlowIR, Node } from '@flowforger/ir';

// "Parse JSON" as the cloud runs it; every expectation was measured by conformance/flows/parse-json.ff.ts.

const B = String.fromCharCode(92); // a backslash, for JSON escapes in the inputs below

const read = (text: string) => {
  const node = readNewtonsoftJson(text);
  return node === undefined ? undefined : nodeToValue(node);
};
const readError = (text: string) => {
  try {
    readNewtonsoftJson(text);
  } catch (err) {
    assert.ok(err instanceof JsonReaderError);
    return err.message;
  }
  assert.fail(`expected ${JSON.stringify(text)} to fail`);
};
const errors = (value: unknown, schema: object) => {
  const node = typeof value === 'string' ? readNewtonsoftJson(value)! : readNewtonsoftJson(JSON.stringify(value))!;
  return validateJsonSchema(node, schema);
};
const messages = (value: unknown, schema: object) => errors(value, schema).map((e) => e.message);

describe('Newtonsoft reader: what it accepts', () => {
  const cases: Array<[string, unknown]> = [
    ["{'a':'b'}", { a: 'b' }],
    ['{a:1}', { a: 1 }],
    ['{1:2}', { '1': 2 }],
    ['{"a":1 /* c */} // end', { a: 1 }],
    ['[1,2,]', [1, 2]],
    ['{"a":1,}', { a: 1 }],
    ['[,1]', [null, 1]],
    ['{} x', {}],
    ['{}{}', {}],
    ['{"a":1}}', { a: 1 }],
    ['1 x', 1],
    ['[NaN, Infinity, undefined]', ['NaN', 'Infinity', null]],
    ['{"a":undefined}', { a: null }],
    ['{"a":1,"a":2}', { a: 2 }],
    ['[0x1A]', [26]],
    ['[010]', [8]],
    ['[-010]', [-10]],
    ['[.5]', [0.5]],
    ['[1.]', [1]],
    ['[-0]', [0]],
    ['[1e2,-1.5E-3,1.0]', [100, -0.0015, 1]],
    ['[1.7976931348623157E+309]', ['Infinity']],
    // End of input right after a value closes every open container.
    ['[1', [1]],
    ['[1  ', [1]],
    ['[[1]', [[1]]],
    ['{"a":1', { a: 1 }],
    ['{"a":12', { a: 12 }],
    ['{"a":{"b":1}', { a: { b: 1 } }],
    ['[{"a":1}', [{ a: 1 }]],
    [`["${B}'"]`, ["'"]],
    [`"${B}ud83d${B}ude00 ${B}u00e4"`, '\u{1F600} ä'],
    ['"a\tb"', 'a\tb'],
    ['["2026-03-05T14:07:09.1234567+02:00","/Date(1234567890000)/"]', ['2026-03-05T14:07:09.1234567+02:00', '/Date(1234567890000)/']],
  ];
  for (const [text, expected] of cases) {
    it(`reads ${JSON.stringify(text)}`, () => assert.deepEqual(read(text), expected));
  }

  it('reads whitespace alone as nothing', () => assert.equal(read('  '), undefined));
});

describe('Newtonsoft reader: error messages', () => {
  const cases: Array<[string, string]> = [
    ['hello', "Unexpected character encountered while parsing value: h. Path '', line 0, position 0."],
    [' h', "Unexpected character encountered while parsing value: h. Path '', line 1, position 1."],
    ['}', "Unexpected character encountered while parsing value: }. Path '', line 0, position 0."],
    ['[}', "Unexpected character encountered while parsing value: }. Path '', line 1, position 1."],
    ['[+1]', "Unexpected character encountered while parsing value: +. Path '', line 1, position 1."],
    ['{\r\n"a":\r\n  x}', "Unexpected character encountered while parsing value: x. Path 'a', line 3, position 2."],
    ['[1,\n2,\nx]', "Unexpected character encountered while parsing value: x. Path '[1]', line 3, position 0."],
    [']', "JsonToken EndArray is not valid for closing JsonType None. Path '', line 1, position 1."],
    ['{"a":1,', "Unexpected end when reading token. Path ''."],
    ['{"a":', "Unexpected end when reading token. Path ''."],
    ['{', "Unexpected end when reading token. Path ''."],
    ['[', "Unexpected end when reading token. Path ''."],
    ['[1,', "Unexpected end when reading token. Path ''."],
    ['{"a":[1,{"b":', "Unexpected end when reading token. Path 'a[1]'."],
    ['[tr', "Unexpected end when reading JSON. Path '', line 1, position 3."],
    ['[1,tru]', "Error parsing boolean value. Path '[0]', line 1, position 6."],
    ['{"a":\n  nul}', "Error parsing null value. Path 'a', line 2, position 5."],
    ['{"a":Infinityx}', "Error parsing Infinity value. Path 'a', line 1, position 13."],
    ['[1 2]', "After parsing a value an unexpected character was encountered: 2. Path '[0]', line 1, position 3."],
    ['{"a":1 "b":2}', `After parsing a value an unexpected character was encountered: ". Path 'a', line 1, position 7.`],
    ['{"a":1,,"b":2}', "Invalid property identifier character: ,. Path 'a', line 1, position 7."],
    ['{]', "Invalid property identifier character: ]. Path '', line 1, position 1."],
    ['{"a" 1}', "Invalid character after parsing property name. Expected ':' but got: 1. Path '', line 1, position 5."],
    ['"abc', `Unterminated string. Expected delimiter: ". Path '', line 1, position 4.`],
    ['{"a', `Unterminated string. Expected delimiter: ". Path '', line 1, position 3.`],
    ['{"a":"x', `Unterminated string. Expected delimiter: ". Path 'a', line 1, position 7.`],
    [`"${B}q"`, `Bad JSON escape sequence: ${B}q. Path '', line 1, position 3.`],
    [`["a${B}u0041${B}x41"]`, `Bad JSON escape sequence: ${B}x. Path '', line 1, position 11.`],
    [`"${B}u12G4"`, `Invalid Unicode escape sequence: ${B}u12G4. Path '', line 1, position 3.`],
    ['[1 /* c', "Unexpected end while parsing comment. Path '[0]', line 1, position 7."],
    ['[1.2.3]', "Input string '1.2.3' is not a valid number. Path '[0]', line 1, position 6."],
    ['[08]', "Input string '08' is not a valid number. Path '[0]', line 1, position 3."],
    ['[01.5]', "Input string '01.5' is not a valid number. Path '[0]', line 1, position 5."],
    ['[1e]', "Input string '1e' is not a valid number. Path '[0]', line 1, position 3."],
    ['[-]', "Input string '-' is not a valid number. Path '[0]', line 1, position 2."],
    ['[-0x1A]', "Input string '-0x1A' is not a valid number. Path '[0]', line 1, position 6."],
    ['[-Infinity,-NaN]', "Unexpected character encountered while parsing number: N. Path '[0]', line 1, position 12."],
  ];
  for (const [text, expected] of cases) {
    it(`rejects ${JSON.stringify(text)}`, () => assert.equal(readError(text), expected));
  }
});

describe('schema validation', () => {
  it('reports a type mismatch with the value, a path and the schema pointer', () => {
    assert.deepEqual(errors('{"name":1}', { type: 'object', properties: { name: { type: 'string' } } }), [
      {
        message: 'Invalid type. Expected String but got Integer.',
        lineNumber: 0,
        linePosition: 0,
        path: 'name',
        value: 1,
        schemaId: '#/properties/name',
        errorType: 'type',
        childErrors: [],
      },
    ]);
  });

  it('leaves the value out for null, objects and arrays', () => {
    const errs = errors('{"a":null,"b":[1],"c":{}}', {
      properties: { a: { type: 'string' }, b: { type: 'object' }, c: { type: 'array' } },
    });
    assert.deepEqual(errs.map((e) => [e.message, 'value' in e]), [
      ['Invalid type. Expected String but got Null.', false],
      ['Invalid type. Expected Object but got Array.', false],
      ['Invalid type. Expected Array but got Object.', false],
    ]);
  });

  it('lists several types in flag order and tells floats from integers', () => {
    assert.deepEqual(
      messages('{"a":1,"b":true,"e":1.5,"g":null,"k":1.0}', {
        properties: {
          a: { type: ['string', 'null'] },
          b: { type: ['null', 'integer', 'string'] },
          e: { type: 'integer' },
          g: { type: ['boolean', 'integer'] },
          k: { type: 'integer' },
        },
      }),
      [
        'Invalid type. Expected String, Null but got Integer.',
        'Invalid type. Expected String, Integer, Null but got Boolean.',
        'Invalid type. Expected Integer but got Number.',
        'Invalid type. Expected Integer, Boolean but got Null.',
      ],
    );
  });

  it('reports nested items in document order, required at the end of each object', () => {
    const errs = errors('{"rows":[{"name":"a","n":1},{"name":2,"n":"x"},{"n":3}]}', {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, n: { type: 'integer' } }, required: ['name'] },
        },
      },
    });
    assert.deepEqual(errs.map((e) => [e.path, e.schemaId, e.errorType, e.value]), [
      ['rows[1].name', '#/properties/rows/items/properties/name', 'type', 2],
      ['rows[1].n', '#/properties/rows/items/properties/n', 'type', 'x'],
      ['rows[2]', '#/properties/rows/items', 'required', ['name']],
    ]);
  });

  it('orders an object: members, combinators, required, property counts', () => {
    const errs = errors('{"o":{"a":1,"x":2}}', {
      properties: {
        o: {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['b'],
          maxProperties: 1,
          additionalProperties: false,
          allOf: [{ required: ['c'] }],
        },
      },
    });
    assert.deepEqual(errs.map((e) => [e.errorType, e.path]), [
      ['type', 'o.a'],
      ['additionalProperties', 'o.x'],
      ['allOf', 'o'],
      ['required', 'o'],
      ['maxProperties', 'o'],
    ]);
    assert.equal(errs[1].message, "Property 'x' has not been defined and the schema does not allow additional properties.");
    assert.equal(errs[1].value, 'x');
    assert.equal(errs[1].schemaId, '#/properties/o');
  });

  it('orders a string: lengths, enum, then combinators', () => {
    assert.deepEqual(
      messages('{"s":"toolong"}', { properties: { s: { type: 'string', maxLength: 3, enum: ['a'], minLength: 10, allOf: [{ maxLength: 2 }] } } }),
      [
        "String 'toolong' exceeds maximum length of 3.",
        "String 'toolong' is less than minimum length of 10.",
        'Value "toolong" is not defined in enum.',
        "JSON does not match all schemas from 'allOf'. Invalid schema indexes: 0.",
      ],
    );
  });

  it('writes the constraint messages', () => {
    assert.deepEqual(
      messages('{"kind":"z","age":-1,"list":[],"many":[1,2,3],"big":11,"step":7,"uniq":[1,1],"exMin":0,"exMax":5,"n":{"a":1},"f":1.5,"h":0.3,"i":0}', {
        properties: {
          kind: { enum: ['a', 'b'] },
          age: { minimum: 0 },
          list: { minItems: 1 },
          many: { maxItems: 2 },
          big: { maximum: 10 },
          step: { multipleOf: 5 },
          uniq: { uniqueItems: true },
          exMin: { minimum: 0, exclusiveMinimum: true },
          exMax: { maximum: 5, exclusiveMaximum: true },
          n: { minProperties: 2, maxProperties: 0 },
          f: { minimum: 2 },
          h: { multipleOf: 0.1 },
          i: { minimum: 0.5 },
        },
      }),
      [
        'Value "z" is not defined in enum.',
        'Integer -1 is less than minimum value of 0.',
        'Array item count 0 is less than minimum count of 1.',
        'Array item count 3 exceeds maximum count of 2.',
        'Integer 11 exceeds maximum value of 10.',
        'Integer 7 is not a multiple of 5.',
        'Non-unique array item at index 1.',
        'Integer 0 equals minimum value of 0 and exclusive minimum is true.',
        'Integer 5 equals maximum value of 5 and exclusive maximum is true.',
        'Object property count 1 exceeds maximum count of 0.',
        'Object property count 1 is less than minimum count of 2.',
        'Float 1.5 is less than minimum value of 2.',
        'Integer 0 is less than minimum value of 0.5.',
      ],
    );
  });

  it('writes enum values as JSON and compares numbers by value', () => {
    assert.deepEqual(
      messages(`{"e1":1.5,"e2":true,"e3":[1],"e4":"it's","o":{"a":2},"ok":1}`, {
        properties: {
          e1: { enum: ['x'] },
          e2: { enum: ['x'] },
          e3: { enum: ['x'] },
          e4: { enum: ['x'] },
          o: { enum: [{ a: 1 }] },
          ok: { enum: [1.0, '1'] },
        },
      }),
      [
        'Value 1.5 is not defined in enum.',
        'Value true is not defined in enum.',
        'Value [1] is not defined in enum.',
        `Value "it's" is not defined in enum.`,
        'Value {"a":2} is not defined in enum.',
      ],
    );
  });

  it('reports combinator children in reverse schema order', () => {
    const errs = errors('{"any":true,"one":5,"all":"abc","not":"x","none":true}', {
      properties: {
        any: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        one: { oneOf: [{ type: 'integer' }, { type: 'number' }] },
        all: { allOf: [{ maxLength: 1 }, { minLength: 5 }, { type: 'string' }] },
        not: { not: { type: 'string' } },
        none: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      },
    });
    assert.deepEqual(errs.map((e) => [e.message, e.childErrors.map((c) => c.schemaId)]), [
      ["JSON does not match any schemas from 'anyOf'.", ['#/properties/any/anyOf/1', '#/properties/any/anyOf/0']],
      ["JSON is valid against more than one schema from 'oneOf'. Valid schema indexes: 0, 1.", []],
      ["JSON does not match all schemas from 'allOf'. Invalid schema indexes: 0, 1.", ['#/properties/all/allOf/1', '#/properties/all/allOf/0']],
      ["JSON is valid against schema from 'not'.", []],
      ["JSON is valid against no schemas from 'oneOf'.", ['#/properties/none/oneOf/1', '#/properties/none/oneOf/0']],
    ]);
  });

  it('checks schema dependencies with the combinators and key dependencies at the end', () => {
    const errs = errors('{"a":1,"c":2}', {
      type: 'object',
      dependencies: { a: ['b'], c: { required: ['d'] } },
      properties: { c: { const: 1 } },
    });
    assert.deepEqual(errs.map((e) => [e.message, e.value]), [
      ['Value 2 does not match const.', 2],
      ["Dependencies for property 'c' failed.", undefined],
      ["Dependencies for property 'a' failed. Missing required keys: b.", 'a'],
    ]);
    assert.equal(errs[1].childErrors[0].schemaId, '#/dependencies/c');
  });

  it('follows $ref, and quotes paths the way Newtonsoft does', () => {
    assert.deepEqual(
      errors('{"home":{"city":1}}', {
        definitions: { addr: { type: 'object', properties: { city: { type: 'string' } } } },
        properties: { home: { $ref: '#/definitions/addr' } },
      }).map((e) => e.schemaId),
      ['#/definitions/addr/properties/city'],
    );
    assert.deepEqual(
      errors(`{"a b":{"x.y":[{"q'":1,"ok_1":1}]}}`, {
        properties: { 'a b': { properties: { 'x.y': { items: { properties: { "q'": { type: 'string' }, ok_1: { type: 'string' } } } } } } },
      }).map((e) => e.path),
      [`['a b']['x.y'][0]['q${B}'']`, `['a b']['x.y'][0].ok_1`],
    );
  });

  it('checks tuples, additional items and unique objects', () => {
    assert.deepEqual(
      errors('{"t":[1,"a",true],"u":[{"a":1},{"a":1}]}', {
        properties: {
          t: { items: [{ type: 'integer' }, { type: 'integer' }], additionalItems: false },
          u: { uniqueItems: true },
        },
      }).map((e) => [e.message, e.path, e.value]),
      [
        ['Invalid type. Expected Integer but got String.', 't[1]', 'a'],
        ['Index 3 has not been defined and the schema does not allow additional items.', 't[2]', true],
        ['Non-unique array item at index 1.', 'u[1]', { a: 1 }],
      ],
    );
  });

  it('checks the formats Newtonsoft knows', () => {
    const value = {
      d1: '2026-03-05', d2: '2026-13-05', t1: '14:07:09', t2: '25:00', ip1: '10.0.0.1', ip2: '10.0.0.256',
      h1: 'example.com', h2: '-bad-.com', m1: 'a@b', m2: 'nope', u1: 'relative/path', u2: 'https://x.com/a b',
      dt1: '2026-03-05', dt2: '2026-03-05T14:07:09', dt3: '2026-03-05 14:07:09Z', dt4: '2026-03-05T14:07:09.123+02:00',
    };
    const format: Record<string, string> = { d: 'date', t: 'time', ip: 'ipv4', h: 'hostname', m: 'email', u: 'uri', dt: 'date-time' };
    const schema = { properties: Object.fromEntries(Object.keys(value).map((k) => [k, { format: format[k.replace(/\d$/, '')] }])) };
    assert.deepEqual(errors(value, schema).map((e) => e.path), ['d2', 't2', 'ip2', 'h2', 'm2', 'u1', 'u2', 'dt1', 'dt3']);
  });

  it('applies object and string keywords only to their own kinds', () => {
    assert.deepEqual(errors('[1,"a"]', { properties: { a: { type: 'string' } }, required: ['a'], maxLength: 0 }), []);
  });
});

describe('the Parse JSON action', () => {
  it('outputs the body as read, without coercing it to the schema', () => {
    assert.deepEqual(parseJsonAction('{"num":"1","extra":true}', { properties: { num: { type: 'string' } } }), {
      status: 'Succeeded',
      outputs: { body: { num: '1', extra: true } },
    });
    assert.deepEqual(parseJsonAction(3, { type: 'integer' }).outputs, { body: 3 });
    assert.deepEqual(parseJsonAction({ a: 1 }, {}).outputs, { body: { a: 1 } });
  });

  it('fails a schema mismatch with ValidationFailed and outputs { errors } only', () => {
    const r = parseJsonAction('{"name":1}', { properties: { name: { type: 'string' } } });
    assert.equal(r.status, 'Failed');
    assert.equal(r.code, 'ValidationFailed');
    assert.deepEqual(r.cloudError, { code: 'ValidationFailed', message: 'The schema validation failed.', messageTemplate: 'The schema validation failed.' });
    assert.deepEqual(Object.keys(r.outputs as object), ['errors']);
  });

  it('fails text that is not JSON with InvalidJSON and no outputs', () => {
    const r = parseJsonAction('{"a":1,', {});
    assert.equal(r.code, 'InvalidJSON');
    assert.equal(r.outputs, undefined);
    assert.equal(
      r.cloudError!.message,
      "The 'content' property of actions of type 'ParseJson' must be valid JSON. The provided value cannot be parsed: 'Unexpected end when reading token. Path ''.'.",
    );
  });

  it('refuses pattern / patternProperties in the schema, but not a property named pattern', () => {
    const r = parseJsonAction('{"zip":"123"}', { properties: { zip: { type: 'string', pattern: '^[0-9]+$' } } });
    assert.equal(r.code, 'ActionSchemaNotSupported');
    assert.match(r.cloudError!.message, /^The 'schema' property of action 'ParseJson' inputs contains 'pattern'/);
    assert.equal(parseJsonAction('{"pattern":"x"}', { properties: { pattern: { type: 'string' } } }).status, 'Succeeded');
  });

  it('refuses binary content whatever its type', () => {
    const r = parseJsonAction({ '$content-type': 'application/json', '$content': 'eyJhIjogMX0=' }, {});
    assert.equal(r.code, 'BadRequest');
    assert.equal(r.cloudError!.message, "The property 'content' must be of type JSON in the 'ParseJson' action inputs, but was of type 'application/json'.");
  });

  it('validates whitespace content as null', () => {
    assert.deepEqual(parseJsonAction('  ', {}).outputs, { body: null });
    assert.equal(parseJsonAction('  ', { type: 'object' }).code, 'ValidationFailed');
  });

  it('fails null and empty content in the template, as actions() and body() show', async () => {
    const trigger = { id: 'trg_1', name: 'manual', type: 'trigger', kind: 'manual', inputs: {} } as any;
    const parse = (name: string, from: unknown, schema: object, runAfter?: string): Node =>
      ({ id: `act_${name}`, name, type: 'action', kind: 'parsejson', inputs: { from, schema }, ...(runAfter ? { runAfter: { [runAfter]: ['Succeeded', 'Failed'] } } : {}) }) as any;
    const flow: FlowIR = {
      name: 'parse-json',
      nodes: [
        trigger,
        parse('Empty', '', {}),
        parse('Typed', '{"name":1}', { properties: { name: { type: 'string' } } }, 'Empty'),
        {
          id: 'act_Probe',
          name: 'Probe',
          type: 'action',
          kind: 'compose',
          inputs: {
            value: {
              emptyCode: "@actions('Empty')?['code']",
              emptyError: "@actions('Empty')?['error']",
              typedCode: "@actions('Typed')?['code']",
              typedBody: "@body('Typed')",
              typedPath: "@outputs('Typed')?['errors'][0]['path']",
            },
          },
          runAfter: { Typed: ['Succeeded', 'Failed'] },
        } as any,
      ],
    };
    const result = await run(flow);
    assert.deepEqual(result.trace.find((t) => t.name === 'Probe')!.outputs, {
      emptyCode: 'BadRequest',
      emptyError: {
        code: 'InvalidTemplate',
        message:
          "Unable to process template language expressions in action 'Empty' inputs at line '0' and column '0': 'Required property 'content' expects a value but got null. Path ''.'.",
        messageTemplate: "Unable to process template language expressions in action '{0}' inputs at line '{1}' and column '{2}': '{3}'.",
      },
      typedCode: 'ValidationFailed',
      typedBody: null,
      typedPath: 'name',
    });
  });
});
