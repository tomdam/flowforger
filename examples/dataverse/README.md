# Dataverse Examples

One flow per Dataverse connector operation area, all using `ctx.connectors.dataverse`.

## Files

| File | Demonstrates |
|---|---|
| [list-rows.ff.ts](list-rows.ff.ts) | `ListRows` with column selection |
| [create-row.ff.ts](create-row.ff.ts) | `CreateRecord` with `item/<column>` field values |
| [update-row.ff.ts](update-row.ff.ts) | `UpdateOnlyRecord` (PATCH semantics — only specified fields change) |
| [delete-row.ff.ts](delete-row.ff.ts) | `DeleteRecord` by GUID |
| [search.ff.ts](search.ff.ts) | `GetRelevantRows` (Dataverse search): global, table-scoped, filtered |
| [relationships.ff.ts](relationships.ff.ts) | `UpsertRecord` + `AssociateEntities`/disassociate via relationship names |
| [batch-operations.ff.ts](batch-operations.ff.ts) | `ExecuteChangeset` — multiple operations as one atomic changeset |
| [custom-actions.ff.ts](custom-actions.ff.ts) | `PerformBoundAction` / unbound custom actions |
| [file-operations.ff.ts](file-operations.ff.ts) | `GetEntityFileImageFieldContent` / `UpdateEntityFileImageFieldContent` (base64 binary content) |

All examples use the standard `accounts`/`contacts` tables and placeholder record IDs — point them at your own environment and IDs to run them for real.

## Running

See [examples/README.md](../README.md) for CLI install/setup. Dataverse flows need credentials:

```bash
# With automatic token acquisition (MSAL device-code login, cached afterwards)
npx flowforger run examples/dataverse/list-rows.ff.ts --auth

# Or with an explicit token
npx flowforger run examples/dataverse/list-rows.ff.ts \
  --dv-url https://your-org.crm.dynamics.com --dv-token <AAD_TOKEN>

# Compile any of them to Logic Apps JSON without credentials
npx flowforger compile examples/dataverse/create-row.ff.ts --out clientdata.json
```
