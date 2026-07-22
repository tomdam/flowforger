# Optimizer Example

Demonstrates the FlowForger DSL optimizer (`flowforger optimize`), which rewrites common inefficient flow patterns into faster Power Automate equivalents.

## Files

- [unoptimized.ff.ts](unoptimized.ff.ts) — Input flow containing two optimization opportunities
- [optimized.ff.ts](optimized.ff.ts) — Output produced by the optimizer
- [report.json](report.json) — Machine-readable report of the changes applied

## What the Optimizer Does

| Optimization | Before | After | Why |
|---|---|---|---|
| Single-set variable → Compose | `InitializeVariable` that is never mutated | `Compose` action | Compose is cheaper and side-effect free |
| Loop + append → Select | `foreach` loop appending to an array variable | Single `Select` action | Select maps the whole array in one action and removes the sequential loop, enabling parallelism |

It can also warn about patterns that block Power Automate's concurrency (see `--no-parallelism-warnings`).

## Running

See [examples/README.md](../README.md) for CLI install/setup.

```bash
# Optimize the example flow and write a change report
npx flowforger optimize examples/optimizer/unoptimized.ff.ts \
  --out examples/optimizer/optimized.ff.ts \
  --report examples/optimizer/report.json
```

### Options

```
--out <file>                  Output file (default: input.optimized.ts)
--report <file>               Write JSON optimization report to file
--no-variable-to-compose      Disable single-set variable to compose optimization
--no-loop-variable-to-compose Disable loop variable to compose optimization
--no-append-to-select         Disable append-to-array to select optimization
--no-parallelism-warnings     Disable parallelism warnings
```

## Notes

- The optimizer works source-to-source on the DSL: it parses the `.ff.ts`, applies the rewrites, and emits DSL again — so the output stays reviewable and editable.
- Optimizer output is meant as a starting point: review the result before deploying, as with any generated code.
- The optimizer carries the input file's comments through to the output, so re-running the command overwrites the header comment in [optimized.ff.ts](optimized.ff.ts) (it has been adjusted by hand here to describe the output).
