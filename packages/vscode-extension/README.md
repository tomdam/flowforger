# FlowForger for VS Code

Build Power Automate and Logic Apps flows as TypeScript — with IntelliSense, local debugging, and compilation to Logic Apps JSON.

## Features

- **IntelliSense**: Autocomplete for `ctx.*` methods, connectors, action names, and variables
- **Diagnostics**: Real-time error detection for invalid references, missing decorators
- **Hover Documentation**: Rich documentation for methods and decorators
- **Snippets**: 20+ code snippets for common patterns
- **Syntax Highlighting**: Special highlighting for FlowForger decorators and methods
- **Edit & Continue**: While paused, edit the flow and press Restart (Ctrl+Shift+F5) — the run restarts under the hood, replaying recorded connector/HTTP responses (unchanged calls are never re-sent) and fast-forwarding back to the paused position or the first divergence. Restarting while not paused does a normal clean run.
- **Set Next Statement**: While paused, right-click a line and choose "Jump to Cursor" to move the execution point — backward to re-execute with live connector calls, forward to skip. From a loop-iteration or branch-child pause, a backward jump restarts and replays up to the target instead (console variable edits are not preserved).

## File Extension

FlowForger DSL files use the `.ff.ts` extension.

## Quick Start

1. Create a new file with `.ff.ts` extension
2. Start typing `flow-class` to use the snippet
3. Use `ctx.` to see available methods

## Example

Create `hello-flow.ff.ts`:

```typescript
@Flow('hello-flow')
class HelloFlow {
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

    // Pull the echoed message out of the response
    await ctx.compose('Echo', ctx.body('CallHttpBin')?.['json']);
  }
}
```

> **No imports needed.** `@Flow`, `@ManualTrigger`, `@Action`, and `FlowContext` are ambient globals
> recognized by the FlowForger compiler and this extension.
> Reference a **Compose** action's output with `ctx.outputs('Name')` and an **HTTP** action's response
> body with `ctx.body('Name')`.

## Commands

- **FlowForger: Restart Language Server** - Restart the LSP server
- **FlowForger: Compile to IR** - Compile current file to FlowIR JSON
- **FlowForger: Compile to Logic Apps JSON** - Compile to Power Automate format

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `flowforger.enable` | Enable language features | `true` |
| `flowforger.diagnostics.enable` | Enable diagnostic reporting | `true` |
| `flowforger.diagnostics.showUnusedWarnings` | Show unused action/variable warnings | `true` |
| `flowforger.trace.server` | Trace LSP communication | `off` |

## Requirements

None — the language server, compiler, emitter, and debugger are fully bundled with the extension. No workspace setup or Node.js installation required.

For command-line workflows (CI, deployment), see the [flowforger CLI](https://www.npmjs.com/package/flowforger) on npm.

## License

Apache-2.0
