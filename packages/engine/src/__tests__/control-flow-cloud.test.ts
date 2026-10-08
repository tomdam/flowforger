import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, type BaseConnector, type TraceEntry } from '../index.js';
import type { FlowIR, Node } from '@flowforger/ir';

// Error handling and control flow as the cloud reports them to actions() / result(),
// measured by conformance/flows/control.ff.ts.

const TRIGGER = { id: 'trg_1', name: 'manual', type: 'trigger', kind: 'manual', inputs: {} } as any;
const flow = (nodes: Node[]): FlowIR => ({ name: 'cloud-control', nodes: [TRIGGER, ...nodes] });
const compose = (name: string, value: any, extra: object = {}): Node =>
  ({ id: `act_${name}`, name, type: 'action', kind: 'compose', inputs: { value }, ...extra }) as any;
const scope = (name: string, actions: Node[], extra: object = {}): Node =>
  ({ id: `scp_${name}`, name, type: 'scope', actions, ...extra }) as any;
const after = (name: string, ...statuses: string[]) => ({ runAfter: { [name]: statuses } });

/** Run a flow ending in a Compose `Probe` and return what the probe evaluated. */
async function probe(nodes: Node[], value: any, options = {}) {
  const result = await run(flow([...nodes, compose('Probe', value, after(nodes[nodes.length - 1].name, 'Succeeded', 'Failed', 'Skipped'))]), options);
  return result.trace.find(t => t.name === 'Probe')!.outputs;
}

const notFound: BaseConnector = {
  async invoke() {
    throw Object.assign(new Error('Not Found'), { status: 404, response: { message: 'Item Not Found' } });
  },
};

describe('actions() and result() records', () => {
  it('reports a connector failure by its HTTP status, without an error object', async () => {
    const out = await probe(
      [
        scope('Try', [
          compose('First', 'ok'),
          { id: 'con_1', name: 'Get', type: 'connector', connector: 'sp', operation: 'GetItem', params: { id: 1 }, ...after('First', 'Succeeded') } as any,
          compose('Next', 'never', after('Get', 'Succeeded')),
        ]),
      ],
      { try: "@actions('Try')", get: "@actions('Get')", next: "@actions('Next')", result: "@result('Try')" },
      { connectors: { sp: notFound } },
    );
    assert.equal(out.try.code, 'ActionFailed');
    assert.deepEqual(out.try.error, {
      code: 'ActionFailed',
      message: 'An action failed. No dependent actions succeeded.',
      messageTemplate: 'An action failed. No dependent actions succeeded.',
    });
    assert.equal(out.get.code, 'NotFound');
    assert.equal(out.get.error, undefined);
    assert.deepEqual(out.get.inputs, { parameters: { id: 1 } });
    assert.equal(out.get.outputs.statusCode, 404);
    assert.equal(out.next.code, 'ActionSkipped');
    assert.equal(
      out.next.error.message,
      "The execution of template action 'Next' is skipped: the 'runAfter' condition for action 'Get' is not satisfied. Expected status values 'Succeeded' and actual value 'Failed'.",
    );
    assert.deepEqual(out.result.map((r: any) => [r.name, r.status, r.code]), [
      ['First', 'Succeeded', 'OK'],
      ['Get', 'Failed', 'NotFound'],
      ['Next', 'Skipped', 'ActionSkipped'],
    ]);
    assert.deepEqual(out.result[0].inputs, 'ok'); // a Compose's inputs are its value
    for (const key of ['startTime', 'endTime', 'trackingId', 'clientTrackingId']) assert.ok(out.result[0][key], key);
  });

  it('reports an expression failure as InvalidTemplate, with no inputs or outputs', async () => {
    const out = await probe([compose('Bad', '@div(1, 0)')], "@actions('Bad')");
    assert.equal(out.code, 'BadRequest');
    assert.equal(out.error.code, 'InvalidTemplate');
    assert.equal(
      out.error.message,
      "Unable to process template language expressions in action 'Bad' inputs at line '0' and column '0': 'Attempt to divide an integral or decimal value by zero in function 'div'.'.",
    );
    assert.equal('inputs' in out, false);
    assert.equal('outputs' in out, false);
  });

  it('lists every expected status in a skip message', async () => {
    const out = await probe([compose('Root', 1), compose('Skip', 2, after('Root', 'Failed', 'Skipped'))], "@actions('Skip')?['error']?['message']");
    assert.match(out, /Expected status values 'Failed, Skipped' and actual value 'Succeeded'\.$/);
  });

  it('skips the children of a skipped scope, naming the scope', async () => {
    const out = await probe(
      [compose('Root', 1), scope('NotRun', [compose('Inside', 2)], after('Root', 'Failed'))],
      { inside: "@actions('Inside')", result: "@result('NotRun')" },
    );
    assert.equal(out.inside.status, 'Skipped');
    assert.equal(out.inside.error.code, 'ActionDependencyFailed');
    assert.equal(
      out.inside.error.message,
      "The execution of template action 'Inside' is skipped: dependant action 'NotRun' completed with status 'Skipped' and code 'ActionSkipped'.",
    );
    assert.deepEqual(out.result.map((r: any) => r.name), ['Inside']);
  });

  it('keeps a scope Succeeded when a failure inside it is handled', async () => {
    const out = await probe(
      [scope('Caught', [compose('Fail', '@div(1, 0)'), compose('Handle', 'ok', after('Fail', 'Failed'))])],
      "@actions('Caught')",
    );
    assert.equal(out.status, 'Succeeded');
    assert.equal('code' in out, false); // NotSpecified is not shown
  });
});

describe('if and switch branches', () => {
  it('records the branch an if did not take as skipped by its branching condition', async () => {
    const out = await probe(
      [{ id: 'if_1', name: 'Check', type: 'if', condition: '@equals(1, 2)', actions: [compose('Then', 1)], elseActions: [compose('Else', 2)] } as any],
      { then: "@actions('Then')", result: "@result('Check')" },
    );
    assert.equal(out.then.error.code, 'ActionBranchingConditionNotSatisfied');
    assert.deepEqual(out.result.map((r: any) => [r.name, r.status]), [['Then', 'Skipped'], ['Else', 'Succeeded']]);
  });

  const switchNode = (name: string, expression: string, caseValue: any): Node =>
    ({
      id: `sw_${name}`,
      name,
      type: 'switch',
      expression,
      cases: [{ name: `${name}_case`, value: caseValue, actions: [compose(`${name}_hit`, 'case')] }],
      defaultActions: [compose(`${name}_default`, 'default')],
    }) as any;

  it('fails every branch action when a case value has another type than the expression', async () => {
    const result = await run(flow([switchNode('Sw', '@add(1, 1)', '2')]));
    const sw = result.trace.find(t => t.name === 'Sw')!;
    assert.equal(sw.status, 'Failed');
    assert.deepEqual(sw.children!.map(c => c.status), ['Failed', 'Failed']);
    const out = await probe([switchNode('Sw', '@add(1, 1)', '2')], "@actions('Sw_hit')");
    assert.equal(out.code, 'InternalServerError');
    assert.match(out.error.message, /strongEquals' expects parameters of same type, but found 'Integer,String' distinct types/);
  });

  it('fails a switch on null and skips its branches', async () => {
    const out = await probe([switchNode('Sw', "@json('{}')?['missing']", 'x')], { sw: "@actions('Sw')", hit: "@actions('Sw_default')" });
    assert.equal(out.sw.code, 'ExpressionEvaluationFailed');
    assert.match(out.sw.error.message, /It is of type 'Null' but is expected to be a value of type 'String, Integer'\.$/);
    assert.equal(out.hit.status, 'Skipped');
    assert.equal(out.hit.error.code, 'ActionDependencyFailed');
  });

  it('matches case-sensitively and skips the other branches', async () => {
    const out = await probe([switchNode('Sw', "@concat('Op', 'en')", 'open')], { hit: "@actions('Sw_hit')", def: "@actions('Sw_default')?['status']" });
    assert.equal(out.hit.error.code, 'ActionBranchingConditionNotSatisfied');
    assert.equal(out.def, 'Succeeded');
  });
});

describe('loops', () => {
  const until = (name: string, variable: string, body: Node[], condition: string, limit?: number): Node[] => [
    { id: `act_init_${variable}`, name: `Init_${variable}`, type: 'action', kind: 'initializevariable', inputs: { name: variable, type: 'integer', value: 0 } } as any,
    {
      id: `du_${name}`,
      name,
      type: 'dountil',
      condition,
      ...(limit ? { limit } : {}),
      actions: [
        { id: `act_inc_${variable}`, name: `Inc_${variable}`, type: 'action', kind: 'incrementvariable', inputs: { name: variable, value: 1 } } as any,
        ...body,
      ],
    } as any,
  ];

  it('ends an Until at its count limit without failing it', async () => {
    const out = await probe(until('Loop', 'n', [], "@greater(variables('n'), 100)", 3), { status: "@actions('Loop')?['status']", n: "@variables('n')" });
    assert.deepEqual(out, { status: 'Succeeded', n: 3 });
  });

  it('keeps an Until going after a failed iteration and takes the last iteration status', async () => {
    const step = compose('Step', "@div(10, sub(2, variables('n')))", after('Inc_n', 'Succeeded'));
    const recovers = await probe(until('Loop', 'n', [step], "@greaterOrEquals(variables('n'), 3)"), {
      status: "@actions('Loop')?['status']",
      n: "@variables('n')",
      last: "@last(result('Loop'))",
    });
    assert.equal(recovers.status, 'Succeeded');
    assert.equal(recovers.n, 3);
    assert.equal(recovers.last.outputs, -10); // result() holds the last iteration
    assert.equal(recovers.last.repetitionCount, 3);

    const endsFailed = await probe(until('Loop', 'n', [step], "@greaterOrEquals(variables('n'), 2)"), "@actions('Loop')");
    assert.equal(endsFailed.status, 'Failed');
    assert.equal(endsFailed.code, 'ActionFailed');
  });

  it('runs every foreach item after one fails, and lists each child once in result()', async () => {
    const out = await probe(
      [
        {
          id: 'fe_1',
          name: 'Loop',
          type: 'foreach',
          itemsExpression: '@createArray(1, 0, 2)',
          actions: [compose('Div', "@div(10, items('Loop'))")],
        } as any,
      ],
      { status: "@actions('Loop')?['status']", result: "@result('Loop')" },
    );
    assert.equal(out.status, 'Failed');
    assert.equal(out.result.length, 1);
    const [div] = out.result;
    assert.deepEqual([div.name, div.status, div.code, div.repetitionCount], ['Div', 'Failed', 'NotSpecified', 3]);
    assert.deepEqual(div.outputs.map((r: any) => [r.status, r.outputs]), [['Succeeded', 10], ['Failed', undefined], ['Succeeded', 5]]);
  });
});

describe('terminate', () => {
  const terminate = (runStatus: string, runError?: object): Node =>
    ({ id: 'act_stop', name: 'Stop', type: 'action', kind: 'terminate', inputs: { runStatus, ...(runError ? { runError } : {}) } }) as any;

  it('succeeds itself, cancels the blocks around it, skips the rest and ends the run with its status', async () => {
    const result = await run(
      flow([scope('Work', [compose('Before', 1), terminate('Failed', { code: 'E1', message: 'stop' }), compose('InnerAfter', 2)]), compose('OuterAfter', 3)]),
    );
    const byName = new Map<string, TraceEntry>();
    const visit = (entries: TraceEntry[]) => entries.forEach(e => (byName.set(e.name, e), visit(e.children ?? [])));
    visit(result.trace);

    assert.equal(result.status, 'Failed');
    assert.deepEqual(result.error, { code: 'E1', message: 'stop' });
    assert.equal(byName.get('Stop')!.status, 'Succeeded');
    assert.equal(byName.get('Work')!.status, 'Cancelled');
    assert.equal(byName.get('InnerAfter')!.status, 'Skipped');
    assert.equal(byName.get('OuterAfter')!.status, 'Skipped');
  });

  it('ends the run Cancelled for runStatus Cancelled', async () => {
    const result = await run(flow([terminate('Cancelled'), compose('After', 1)]));
    assert.equal(result.status, 'Cancelled');
  });
});
