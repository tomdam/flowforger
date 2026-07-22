# FlowForger IR JSON Schema

`flowforger-ir.schema.json` is a **generated** JSON Schema for the `FlowIR` type — the
authoritative, machine-checkable contract for a flow definition (layer 5 in
[`docs/grammar`](../../../docs/grammar/README.md)).

## Regenerating

Do **not** edit `flowforger-ir.schema.json` by hand. Regenerate it from the TypeScript types
whenever `packages/ir/src/index.ts` changes:

```bash
# from repo root
npm run schema            # -> npm run schema -w @flowforger/ir

# or from this package
npm run schema -w @flowforger/ir
```

This runs [`ts-json-schema-generator`](https://github.com/vega/ts-json-schema-generator) over
`src/index.ts`, rooted at the `FlowIR` type, and overwrites the schema file.

Two flags are intentional:

- **`--no-type-check`** — the IR types are already type-checked by the normal `tsc -b` build, and
  the generator's own program build trips over the package's `composite` project-references
  config. Skipping its redundant check keeps generation fast and reliable.
- **`--additional-properties`** — IR objects legitimately carry pass-through fields beyond the
  declared interfaces: Logic Apps parity fields, preserved `metadata` /
  `runtimeConfiguration` / `workflowMetadata`, and properties attached via `as any` in the
  transformer/parser (e.g. `typeCase`, `operationOptions`, `authentication`, `paramsOmitted`,
  and trigger `outputs`). A strict (`additionalProperties: false`) schema would reject valid
  real-world IR, so the schema validates the shape of *known* properties while allowing extras.

The schema is validated against the example IR files under `examples/` and is confirmed to
reject IR missing required fields (e.g. a top-level `name`).

## Using it

```bash
# validate an IR file with any JSON Schema validator, e.g. ajv-cli
npx ajv-cli validate -s packages/ir/schema/flowforger-ir.schema.json -d examples/hello-flow/flow.ir.json
```

The schema's root is `#/definitions/FlowIR`; every IR node type (`ActionNode`, `IfNode`,
`ForeachNode`, `ConnectorActionNode`, …) is emitted under `definitions`.
