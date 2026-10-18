import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '@flowforger/engine';
import type { FlowIR } from '@flowforger/ir';
import { parseMockFlags, parseMocksFile, collectMocks, parseLiveFlags, createRunGuard, isExternalCall, mockedActionsInTrace } from '../run-mocks.js';
import { ArgError } from '../cli-args.js';

const files: Record<string, unknown> = {
  'items.json': { statusCode: 200, body: { value: [{ Title: 'a' }] } },
  'note.json': 'hello',
  'mocks.json': { Get_items: { statusCode: 200, body: { value: [] } }, Note: 'from file' },
  'list.json': [1, 2],
};
const readJson = (f: string) => {
  if (!(f in files)) throw new Error('ENOENT');
  return files[f];
};
const hasAction = (n: string) => ['Get_items', 'Note', 'Send'].includes(n);
const argErr = (re: RegExp) => (e: unknown) => e instanceof ArgError && re.test((e as Error).message);

describe('parseMockFlags', () => {
  it('parses one value into the mocks map', () => {
    assert.deepEqual(parseMockFlags('Get_items=items.json', readJson, hasAction), { Get_items: files['items.json'] });
  });

  it('parses a repeated flag (array value)', () => {
    assert.deepEqual(parseMockFlags(['Get_items=items.json', 'Note=note.json'], readJson, hasAction), {
      Get_items: files['items.json'],
      Note: 'hello',
    });
  });

  it('keeps an = inside the file path', () => {
    const seen: string[] = [];
    parseMockFlags('Note=C:/x/a=b.json', (f) => { seen.push(f); return 1; }, hasAction);
    assert.deepEqual(seen, ['C:/x/a=b.json']);
  });

  it('rejects a bare --mock (no value)', () => {
    assert.throws(() => parseMockFlags(true, readJson, hasAction), argErr(/actionName>=<file/));
  });

  it('rejects a value without =', () => {
    assert.throws(() => parseMockFlags('Get_items', readJson, hasAction), argErr(/expected <actionName>=<file.json>/));
  });

  it('rejects an unknown action name', () => {
    assert.throws(() => parseMockFlags('Nope=items.json', readJson, hasAction), argErr(/no action named 'Nope'/));
  });

  it('rejects the same action mocked twice', () => {
    assert.throws(() => parseMockFlags(['Note=note.json', 'Note=note.json'], readJson, hasAction), argErr(/more than once/));
  });

  it('reports an unreadable file with the action name', () => {
    assert.throws(() => parseMockFlags('Note=missing.json', readJson, hasAction), argErr(/could not read missing.json for 'Note'/));
  });
});

describe('parseMocksFile / collectMocks', () => {
  it('reads one object mapping action names to outputs', () => {
    assert.deepEqual(parseMocksFile('mocks.json', readJson, hasAction), files['mocks.json']);
  });

  it('rejects a bare flag, a repeated flag, a non-object file and an unknown action', () => {
    assert.throws(() => parseMocksFile(true, readJson, hasAction), argErr(/requires a file path/));
    assert.throws(() => parseMocksFile(['a.json', 'b.json'], readJson, hasAction), argErr(/only be specified once/));
    assert.throws(() => parseMocksFile('list.json', readJson, hasAction), argErr(/must be a JSON object/));
    assert.throws(() => parseMocksFile('missing.json', readJson, hasAction), argErr(/could not read missing.json/));
    assert.throws(() => parseMocksFile('mocks.json', readJson, (n) => n === 'Note'), argErr(/no action named 'Get_items' in the flow \(mocks.json\)/));
  });

  it('collectMocks merges the file with --mock entries and refuses an overlap', () => {
    assert.equal(collectMocks({}, readJson, hasAction), undefined);
    assert.deepEqual(collectMocks({ mocks: 'mocks.json', mock: 'Send=note.json' }, readJson, hasAction), {
      Get_items: { statusCode: 200, body: { value: [] } },
      Note: 'from file',
      Send: 'hello',
    });
    assert.throws(() => collectMocks({ mocks: 'mocks.json', mock: 'Note=note.json' }, readJson, hasAction), argErr(/'Note' is already mocked by --mocks/));
  });
});

describe('parseLiveFlags', () => {
  it('accepts repeated flags and comma-separated lists', () => {
    assert.deepEqual([...parseLiveFlags(['Get_items', 'Note, Send'], hasAction, undefined)], ['Get_items', 'Note', 'Send']);
  });

  it('rejects a bare flag, an unknown action and a mocked action', () => {
    assert.throws(() => parseLiveFlags(true, hasAction, undefined), argErr(/requires an action name/));
    assert.throws(() => parseLiveFlags('Nope', hasAction, undefined), argErr(/no action named 'Nope'/));
    assert.throws(() => parseLiveFlags('Note', hasAction, { Note: 1 }), argErr(/listed as live but also mocked/));
  });
});

describe('createRunGuard', () => {
  const connector = { id: 'con_1', name: 'Get_items', type: 'connector', connector: 'sharepoint', operation: 'GetItems', params: {} } as any;
  const http = { id: 'act_2', name: 'Call', type: 'action', kind: 'http', inputs: {} } as any;
  const child = { id: 'act_3', name: 'Child', type: 'action', kind: 'workflow', inputs: {} } as any;
  const compose = { id: 'act_4', name: 'Note', type: 'action', kind: 'compose', inputs: {} } as any;

  it('is undefined without --stop-before or --live', () => {
    assert.equal(createRunGuard({}), undefined);
    assert.equal(createRunGuard({ mocks: { Note: 1 } }), undefined);
  });

  it('classifies external calls', () => {
    assert.deepEqual([connector, http, child, compose].map(isExternalCall), [true, true, true, false]);
  });

  it('--live denies an external call that is neither listed nor mocked, and lets everything else through', () => {
    const guard = createRunGuard({ live: new Set(['Call']), mocks: { Child: { statusCode: 200 } } })!;
    assert.equal(guard.hook(compose, {}), 'continue');
    assert.equal(guard.hook(http, {}), 'continue', 'listed as live');
    assert.equal(guard.hook(child, {}), 'continue', 'mocked');
    assert.equal(guard.deniedLive(), undefined);
    assert.equal(guard.hook(connector, {}), 'stop');
    assert.equal(guard.deniedLive(), 'Get_items');
  });

  it('an empty --live set denies every unmocked external call', () => {
    const guard = createRunGuard({ live: new Set() })!;
    assert.equal(guard.hook(http, {}), 'stop');
  });

  it('an isMocked resolver (pins) counts as mocked, per node and context', () => {
    const pinnedCtx = { iterationStack: [{ loopName: 'Each', index: 0 }] };
    const guard = createRunGuard({ live: new Set(), isMocked: (node, ctx: any) => node.name === 'Get_items' && ctx.iterationStack?.[0]?.index === 0 })!;
    assert.equal(guard.hook(connector, pinnedCtx), 'continue', 'pinned at this iteration');
    assert.equal(guard.hook(connector, { iterationStack: [{ loopName: 'Each', index: 1 }] }), 'stop', 'no pin at the next iteration');
    assert.equal(guard.deniedLive(), 'Get_items');
  });

  it('--stop-before wins over --live and does not count as a denial', () => {
    const guard = createRunGuard({ stopBefore: 'Call', live: new Set(['Call']) })!;
    assert.equal(guard.hook(http, {}), 'stop');
    assert.equal(guard.deniedLive(), undefined);
  });

  it('through the engine: the run stops before the denied call, with its resolved inputs', async () => {
    const flow: FlowIR = {
      name: 'f',
      nodes: [
        { id: 'trg_1', name: 'manual', type: 'trigger', inputs: {} },
        { id: 'act_1', name: 'Site', type: 'action', kind: 'compose', inputs: { value: 'https://x' } },
        { id: 'con_1', name: 'Get_items', type: 'connector', connector: 'sharepoint', operation: 'GetItems', params: { dataset: "@outputs('Site')" } },
        { id: 'con_2', name: 'Create_item', type: 'connector', connector: 'sharepoint', operation: 'PostItem', params: { dataset: "@outputs('Site')", item: { Title: "@length(body('Get_items')?['value'])" } } },
        { id: 'act_9', name: 'After', type: 'action', kind: 'compose', inputs: { value: 1 } },
      ],
    } as any;
    const mocks = { Get_items: { statusCode: 200, body: { value: [1, 2] } } };
    const guard = createRunGuard({ live: new Set(), mocks })!;
    const r = await run(flow, { mocks, onBeforeExecute: guard.hook as any });
    assert.equal(r.stopped, true);
    assert.equal(guard.deniedLive(), 'Create_item');
    assert.deepEqual(r.stoppedBefore, { nodeId: 'con_2', name: 'Create_item', inputs: { dataset: 'https://x', item: { Title: 2 } } });
    assert.deepEqual(r.trace.map((t) => [t.name, t.status, t.mocked ?? false]), [
      ['manual', 'Succeeded', false], ['Site', 'Succeeded', false], ['Get_items', 'Succeeded', true], ['Create_item', 'Cancelled', false],
    ]);
  });
});

describe('mockedActionsInTrace', () => {
  it('collects mocked entries at the top level, in blocks and in loop iterations', () => {
    const trace = [
      { name: 'trigger', status: 'Succeeded' },
      { name: 'A', status: 'Succeeded', mocked: true },
      { name: 'Scope', status: 'Succeeded', children: [{ name: 'B', status: 'Succeeded', mocked: true }, { name: 'C', status: 'Succeeded' }] },
      { name: 'Loop', status: 'Succeeded', iterations: [{ index: 0, status: 'Succeeded', actions: [{ name: 'D', status: 'Succeeded', mocked: true }] }] },
    ];
    assert.deepEqual([...mockedActionsInTrace(trace)].sort(), ['A', 'B', 'D']);
    assert.deepEqual([...mockedActionsInTrace(undefined)], []);
  });
});
