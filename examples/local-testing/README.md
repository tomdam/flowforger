# Local Testing: Mocks, Stop-Before and the Live Guard

How to run a flow locally without letting its writes happen. One flow with one external read and one external write, and the `flowforger run` flags that control which of them really run.

## Files

- [invoice-reminders.ff.ts](invoice-reminders.ff.ts) — HTTP trigger with invoices → `Get_exchange_rate` (GET, the read) → Filter array / Select → `Send_reminders` (POST, the write) → Response. Both calls go to httpbin.org, which echoes what it receives.
- [payloads/invoices.json](payloads/invoices.json) — Four invoices, two of them overdue
- [mocks/exchange-rate.json](mocks/exchange-rate.json) — An answer for the read: `{ statusCode, body }`, the full outputs an HTTP action has
- [mocks/all.json](mocks/all.json) — Answers for both calls, keyed by action name, for a run that touches nothing

Every command below is one line. `npx flowforger` is interchangeable with `flowforger` (global install) or `node packages/cli/dist/index.js` (from this repo).

## 1. A plain run is a live run

```bash
npx flowforger run examples/local-testing/invoice-reminders.ff.ts --in examples/local-testing/payloads/invoices.json
```

Both HTTP calls go out. The trace shows the rate `1.08` echoed back, two reminders built, and the POST's echo under `Respond`. With a connector flow and `--auth`, the same applies: a loop that updates rows updates them. Exit code 0 means the run Succeeded; anything else is 1.

## 2. Stop before the write

```bash
npx flowforger run examples/local-testing/invoice-reminders.ff.ts --in examples/local-testing/payloads/invoices.json --stop-before Send_reminders
```

Everything before `Send_reminders` runs live, the action itself does not. The run ends `Cancelled` with exit code 3 and prints the exact request the action would have sent: the URL, the headers and the two priced reminders in the body. In JSON mode (`--json`, or whenever the output is piped) that is `stoppedBefore: { name, inputs, reason: "stop-before" }`.

## 3. Mock the read, run offline

```bash
npx flowforger run examples/local-testing/invoice-reminders.ff.ts --in examples/local-testing/payloads/invoices.json --mock Get_exchange_rate=examples/local-testing/mocks/exchange-rate.json --stop-before Send_reminders
```

`--mock <Action>=<file>` replaces the action's outputs with the file's JSON: the action does not run, its inputs are still resolved and shown, and later expressions read the file. The file holds the **full outputs**, so for an HTTP, connector or child-flow action it is `{ "statusCode": 200, "body": { ... } }`, because `ctx.body('X')` reads `.body`. Here the mocked rate is `1.25`, so `Reminders` prices the invoices at 1500 and 100 USD, and the trace marks the entry `(mocked)`.

A run can also mock a reading action against an answer you would never get live, such as an empty list, to see what the flow does with it.

## 4. Mock everything: the dry run

```bash
npx flowforger run examples/local-testing/invoice-reminders.ff.ts --in examples/local-testing/payloads/invoices.json --mocks examples/local-testing/mocks/all.json
```

`--mocks <file>` is one JSON object mapping action names to outputs. With both calls mocked the run leaves the machine untouched, ends `Succeeded`, and the trace still carries the resolved `inputs` of every mocked action: what the flow *would* have sent. Pipe it to list them:

```bash
npx flowforger run examples/local-testing/invoice-reminders.ff.ts --in examples/local-testing/payloads/invoices.json --mocks examples/local-testing/mocks/all.json > dry-run.json
jq '[.. | objects | select(.mocked) | {name, inputs}]' dry-run.json
```

```json
[
  { "name": "Get_exchange_rate", "inputs": { "uri": "https://httpbin.org/get?base=EUR&quote=USD&rate=1.08", "method": "GET" } },
  { "name": "Send_reminders", "inputs": { "uri": "https://httpbin.org/post", "method": "POST", "headers": { "Content-Type": "application/json" },
      "body": { "reminders": [ { "number": "INV-1041", "customer": "Acme", "amountEur": 1200, "amountUsd": 1500, "daysOverdue": 12 },
                               { "number": "INV-1043", "customer": "Initech", "amountEur": 80, "amountUsd": 100, "daysOverdue": 3 } ],
                "sentAt": "2026-11-07T08:12:42.0660000Z" } } }
]
```

There is deliberately no `--dry-run` flag: which action is a read and which is a write, and what a plausible answer for each write looks like, is something you (or an AI agent reading the flow) decide per flow. The mocks file is that decision, written down.

## 5. Deny by default: the live guard

```bash
npx flowforger run examples/local-testing/invoice-reminders.ff.ts --in examples/local-testing/payloads/invoices.json --live Get_exchange_rate
```

`--live <Action>[,<Action>]` turns the run deny-by-default: every HTTP, connector or child-flow action must be either mocked or listed as live. The first one that is neither ends the run before it, exactly like `--stop-before` (exit 3, inputs printed, `stoppedBefore.reason` is `"live"`). Here the read is allowed and the run stops at `Send_reminders`. A write you forgot to think about cannot slip through.

## 6. The same against a deployed flow

Once the flow is deployed, a cloud run can write the mocks for you:

```bash
npx flowforger runs --file invoice-reminders.ff.ts --auth                      # recent cloud runs, newest first
npx flowforger run invoice-reminders.ff.ts --auth --replay-run <runId>         # pin every external call to what that run recorded
npx flowforger run-show --run <runId> --file invoice-reminders.ff.ts --auth    # the cloud run in the shape of run --json
```

`--replay-run` takes the run's trigger outputs as the input and pins every HTTP, connector and child-flow action to the outputs the cloud recorded, per loop iteration, a failed action as a failure, while Composes, variables and conditions recompute locally. Safe mode is implied: an external action the run has no pin for stops the run before it. This is how a production failure is reproduced on your machine.

## 7. Stepping instead of stopping

For breakpoints, stepping and inspecting variables, use the debugger in VS Code (the FlowForger extension) or the web app, or expose a session to an AI agent with `flowforger mcp --auth`. The MCP session records connector responses to `~/.flowforger/cassettes/` and replays them on the next start of the same flow.

## Reading the JSON result

`{ status, trace, artifacts }`, `status` one of `Succeeded`, `Failed`, `Cancelled`. Each trace entry is `{ nodeId, name, status, inputs?, outputs?, error?, mocked?, children?, iterations? }`: an HTTP, connector or child-flow action's `outputs` are `{ statusCode, headers, body }`, a Compose's are the value itself, a data operation's are `{ body }`. `inputs` is present for HTTP, connector and child-flow actions, also when they failed. Blocks hold their body under `children`, loops under `iterations[].actions`.
