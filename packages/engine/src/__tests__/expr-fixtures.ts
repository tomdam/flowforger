import type { RunContext } from '../index.js';

export function makeExprContext(): RunContext {
  return {
    workflowName: 'TestFlow',
    variables: {
      count: 5,
      name: 'World',
      Rows: [{ id: 1, name: 'first' }, { id: 2, name: 'second' }],
      obj: { a: { b: [1, 2, 3] } },
      item: { current: true },
      idx: 1,
    },
    actions: new Map<string, any>([
      ['GetRows', { status: 'Succeeded', outputs: { body: { value: [{ id: 7, name: 'row7' }] } } }],
      ['ComposeX', { status: 'Succeeded', outputs: 42 }],
      ['HttpCall', { status: 'Failed', outputs: { statusCode: 500, body: { error: 'boom' } }, error: { message: 'boom' } }],
    ]),
    triggerData: { body: { id: 'trg-1', nested: { deep: 'yes' } }, headers: { h1: 'v1' } },
    parameters: { Site: 'https://contoso', WithDefault: { defaultValue: 'dv' } },
    iterationStack: [],
    scopeResults: new Map(),
    now: () => new Date('2026-01-15T10:30:00Z'),
  } as unknown as RunContext;
}
