# Recurrence Trigger Example

A scheduled flow: the `@RecurrenceTrigger` decorator with a daily schedule and time zone, followed by a few connector-free actions.

## Files

- [recurrence-flow.ff.ts](recurrence-flow.ff.ts) — Daily at 09:00 Eastern → counter and array variables → two Compose actions

## What It Shows

- `@RecurrenceTrigger({ frequency, interval, timeZone, schedule })`
- Variables named with `@action` (`Initialize_counter`, `Increment_counter`, `Append_message`) and an array append with `.push()`
- Typed expression helpers (`ctx.utcNow()`, `ctx.concat()`, `ctx.add()`, `ctx.string()`) instead of raw expression strings

## Schedule options

```typescript
// Every day at 09:00 in a named Windows time zone
@RecurrenceTrigger({ frequency: 'Day', interval: 1, timeZone: 'W. Europe Standard Time', schedule: { hours: [9], minutes: [0] } })

// Every 4 hours
@RecurrenceTrigger({ frequency: 'Hour', interval: 4 })

// Weekdays at 08:00 and 17:00
@RecurrenceTrigger({
  frequency: 'Week',
  interval: 1,
  schedule: { weekDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], hours: [8, 17], minutes: [0] },
})

// The 1st and 15th of each month at 08:00
@RecurrenceTrigger({ frequency: 'Month', interval: 1, schedule: { monthDays: [1, 15], hours: [8], minutes: [0] } })

// Start at a given moment (ISO 8601) in a time zone
@RecurrenceTrigger({ frequency: 'Day', interval: 1, startTime: '2027-06-01T09:00:00', timeZone: 'Eastern Standard Time' })
```

`frequency` is one of `Second`, `Minute`, `Hour`, `Day`, `Week`, `Month`, `Year`. A `schedule` is only allowed with `Day`, `Week` or `Month`; `weekDays` only with `Week` and `monthDays` only with `Month`. Power Automate also rejects a period over 500 days and a `startTime` more than 49 years ahead; `flowforger validate` reports these before you push (DSL045/DSL046).

Time zones are Windows time zone names such as `UTC`, `W. Europe Standard Time`, `GMT Standard Time`, `Eastern Standard Time` or `Tokyo Standard Time`.

A flow with a Recurrence trigger cannot use `ctx.response()`: the cloud refuses to save it (DSL038).

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# Run locally: the trigger fires once, no waiting for the schedule
npx flowforger run examples/recurrence-trigger/recurrence-flow.ff.ts

# Compile to Logic Apps JSON for deployment
npx flowforger compile examples/recurrence-trigger/recurrence-flow.ff.ts --emit logicapps --out recurrence-clientdata.json
```

Expected trace: `CreateMessage` builds `This is your daily notification #1`, `Increment_counter` sets the counter to 1, `Append_message` stores the message object, and `LogNotification` composes the timestamped log line.
