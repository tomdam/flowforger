# Recurrence Trigger Example

This example demonstrates the Recurrence trigger in FlowForger, which enables scheduled workflows to run automatically at specified intervals.

## Recurrence Trigger Features

The Recurrence trigger supports:

- **Frequency**: Second, Minute, Hour, Day, Week, Month, Year
- **Interval**: Run every N units of frequency (e.g., every 3 hours)
- **Count**: Limit total number of executions (optional)
- **Start/End Time**: Time-bounded execution (optional)
- **Time Zone**: Specify timezone for schedule (optional)
- **Advanced Schedule**: Complex scheduling patterns (optional)

## Schedule Options

### Simple Schedules

```typescript
// Every day at 9 AM
.trigger.recurrence({
  frequency: 'Day',
  interval: 1,
  schedule: {
    hours: [9],
    minutes: [0]
  }
})

// Every 4 hours
.trigger.recurrence({
  frequency: 'Hour',
  interval: 4
})

// Every 15 minutes
.trigger.recurrence({
  frequency: 'Minute',
  interval: 15
})
```

### Weekly Schedules

```typescript
// Monday and Friday at 10 AM
.trigger.recurrence({
  frequency: 'Week',
  interval: 1,
  schedule: {
    weekDays: ['Monday', 'Friday'],
    hours: [10],
    minutes: [0]
  }
})

// Weekdays at 8 AM and 5 PM
.trigger.recurrence({
  frequency: 'Week',
  interval: 1,
  schedule: {
    weekDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    hours: [8, 17],
    minutes: [0]
  }
})
```

### Monthly Schedules

```typescript
// 1st and 15th of each month at 8 AM
.trigger.recurrence({
  frequency: 'Month',
  interval: 1,
  schedule: {
    monthDays: [1, 15],
    hours: [8],
    minutes: [0]
  }
})

// Second Tuesday of every month at 2:30 PM
.trigger.recurrence({
  frequency: 'Month',
  interval: 1,
  schedule: {
    monthlyOccurrences: [
      {
        dayOfWeek: 'Tuesday',
        occurrence: 2
      }
    ],
    hours: [14],
    minutes: [30]
  }
})

// Last Friday of each month
.trigger.recurrence({
  frequency: 'Month',
  interval: 1,
  schedule: {
    monthlyOccurrences: [
      {
        dayOfWeek: 'Friday',
        occurrence: -1  // Negative values count from end
      }
    ]
  }
})
```

### Time-Bounded Schedules

```typescript
// Limited count - run 10 times total
.trigger.recurrence({
  frequency: 'Minute',
  interval: 5,
  count: 10
})

// Date range - only run during 2025
.trigger.recurrence({
  frequency: 'Hour',
  interval: 1,
  startTime: '2025-01-01T00:00:00Z',
  endTime: '2025-12-31T23:59:59Z'
})

// Start in future with timezone
.trigger.recurrence({
  frequency: 'Day',
  interval: 1,
  startTime: '2025-06-01T09:00:00',
  timeZone: 'Eastern Standard Time'
})
```

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# Run locally (recurrence triggers fire once for local testing)
npx flowforger run examples/recurrence-trigger/recurrence-flow.ff.ts

# Compile to Logic Apps JSON for deployment
npx flowforger compile examples/recurrence-trigger/recurrence-flow.ff.ts --out recurrence-flow.clientdata.json

# Or from local source (after `npm run build` at repo root)
node packages/cli/dist/index.js run examples/recurrence-trigger/recurrence-flow.ff.ts
```

The generated Logic Apps JSON can be deployed to Power Automate or Azure Logic Apps.

## Generated Logic Apps JSON Structure

The Recurrence trigger emits to Logic Apps format as:

```json
{
  "triggers": {
    "Recurrence": {
      "type": "Recurrence",
      "recurrence": {
        "frequency": "Day",
        "interval": 1,
        "timeZone": "Eastern Standard Time",
        "schedule": {
          "hours": [9],
          "minutes": [0]
        }
      }
    }
  }
}
```

## Reverse Engineering

FlowForger can also reverse-engineer existing Logic Apps JSON with Recurrence triggers back to DSL:

```bash
# Using the CLI
npx flowforger generate-dsl --in recurrence-flow.clientdata.json --out flow.ff.ts --name DailyNotificationFlow
```

This will generate TypeScript DSL code with the `.trigger.recurrence()` method call.

## Time Zones

Common time zone identifiers:
- `UTC`
- `Eastern Standard Time` (US East Coast)
- `Pacific Standard Time` (US West Coast)
- `Central Standard Time` (US Central)
- `GMT Standard Time` (London)
- `W. Europe Standard Time` (Paris, Berlin)
- `Tokyo Standard Time`
- `AUS Eastern Standard Time` (Sydney)

See the [Windows time zone list](https://docs.microsoft.com/en-us/windows-hardware/manufacture/desktop/default-time-zones) for all supported values.

## Engine Behavior

The FlowForger engine treats Recurrence triggers as:
- **Validation**: Confirms the schedule is valid
- **Pass-through**: Does not wait or schedule execution (local testing only)
- **Trace**: Records trigger execution in trace output

For actual scheduled execution, deploy the flow to Power Automate or Azure Logic Apps.

## Use Cases

Common scenarios for Recurrence triggers:

1. **Daily Reports**: Generate reports every morning
2. **Data Sync**: Sync data between systems every hour
3. **Cleanup Jobs**: Delete old records weekly
4. **Monitoring**: Health checks every 5 minutes
5. **Reminders**: Send notifications on specific days
6. **Billing**: Process invoices on 1st and 15th
7. **Maintenance**: Monthly system maintenance windows

## Implementation Details

Recurrence trigger support includes:

- **IR Types** (`@flowforger/ir`): `RecurrenceTriggerNode` and `RecurrenceTriggerInputs` interfaces
- **DSL** (`@flowforger/dsl-native`): `@RecurrenceTrigger(opts)` decorator
- **Emitter** (`@flowforger/emitter-logicapps`): Converts to Logic Apps Recurrence trigger
- **Generator** (`@flowforger/dsl-native`): `generateNativeDslFromLogicApps()` function
- **Engine** (`@flowforger/engine`): Validates and executes for testing

This makes Recurrence triggers fully supported across the entire FlowForger toolchain.
