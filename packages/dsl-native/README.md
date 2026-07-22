# @flowforger/dsl-native

The **FlowForger TypeScript DSL**: author Microsoft Power Automate / Azure Logic Apps flows as plain TypeScript classes, and convert in both directions between TypeScript, FlowForger IR, and Logic Apps JSON.

Flows as code means `git diff`, branches, pull requests, and local testing — things the Power Automate portal can't give you.

## Installation

```bash
npm install @flowforger/dsl-native
```

## Writing a flow

Flows are TypeScript classes with decorators (`@Flow`, `@HttpTrigger`, `@ManualTrigger`, `@RecurrenceTrigger`, `@Action`) in `.ff.ts` files. The decorators and `FlowContext` are ambient — no imports needed inside a flow file:

```ts
@Flow('hello-world-flow')
class HelloWorldFlow {
  @ManualTrigger()
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    // Build a message with a Compose action
    await ctx.compose('Greeting', { message: 'Hello from FlowForger' });

    // POST it to httpbin, which echoes the body back
    await ctx.http('CallHttpBin', {
      method: 'POST',
      url: 'https://httpbin.org/post',
      body: ctx.outputs('Greeting'),
    });
  }
}
```

`FlowContext` exposes HTTP actions, Compose, variables, control flow, and connector shortcuts (SharePoint, Dataverse, Office 365, Teams, ...).

## Converting between formats

```ts
import { transformCode, parseLogicAppsToIR, generateNativeDslFromIR } from '@flowforger/dsl-native';

// TypeScript DSL → IR
const ir = transformCode(sourceCode, 'flow.ff.ts');

// Logic Apps JSON → IR → TypeScript DSL (reverse-engineer an existing flow)
const importedIr = parseLogicAppsToIR(clientdataJson);
const dslSource = generateNativeDslFromIR(importedIr, 'myFlow');
```

Expression syntax is translated between TypeScript and the Logic Apps expression language (`@equals(variables('x'), 1)`) in both directions.

## Related packages

FlowForger is a toolset for building, running, and shipping Microsoft Power Automate / Azure Logic Apps flows as TypeScript.

- [`flowforger`](https://www.npmjs.com/package/flowforger) — command-line interface (compile, validate, run, deploy)
- [`@flowforger/dsl-native`](https://www.npmjs.com/package/@flowforger/dsl-native) — the TypeScript DSL
- [`@flowforger/engine`](https://www.npmjs.com/package/@flowforger/engine) — local execution engine
- [`@flowforger/emitter-logicapps`](https://www.npmjs.com/package/@flowforger/emitter-logicapps) — IR → Logic Apps JSON

Website: [flowforger.net](https://flowforger.net) · Source: [github.com/tomdam/flowforger](https://github.com/tomdam/flowforger) · Issues: [bug tracker](https://github.com/tomdam/flowforger/issues)

## License

Apache-2.0 © Damjan Tomic
