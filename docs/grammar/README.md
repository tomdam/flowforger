# FlowForger DSL — Formal Grammar & Conformance

FlowForger flows are written as **ordinary, syntactically-valid TypeScript**. There is no
FlowForger lexer or parser: a `.ff.ts` file is parsed with the TypeScript compiler (via
[`ts-morph`](https://ts-morph.com)), producing a normal TypeScript AST that the transformer
then *walks looking for patterns it recognizes* and lowers into the
[FlowIR](../../packages/ir/src/index.ts).

That makes FlowForger an **embedded (internal) DSL**. "The grammar of FlowForger DSL" is
therefore not one grammar but a small stack of contracts, and conflating them is the usual
source of confusion:

| Layer | What it constrains | Where it is formalized |
|-------|--------------------|------------------------|
| **1. Host syntax** | Which source strings are legal text | The [TypeScript grammar](https://github.com/microsoft/TypeScript/blob/main/doc/spec-ARCHIVED.md). FlowForger inherits it 100% — it adds **no** syntax. |
| **2. Recognized subset** | Which TypeScript constructs FlowForger actually understands, and what IR they map to | [`flowforger-dsl.ebnf`](./flowforger-dsl.ebnf) — *descriptive, non-authoritative* |
| **3. Annotation language** | The `@action` / `@type` / `@runAfter` … mini-language living inside JSDoc comments | [`jsdoc-tags.ebnf`](./jsdoc-tags.ebnf) — *small and closed; near-authoritative* |
| **4. Semantic rules** | Constraints a context-free grammar **cannot** express (name uniqueness, no `return`, try/catch must have a finally, 256-char descriptions) | [`conformance.md`](./conformance.md) |
| **5. Output contract** | The set of valid flow definitions, independent of how they were authored | [`flowforger-ir.schema.json`](../../packages/ir/schema/flowforger-ir.schema.json) — **authoritative, machine-checkable**, generated from the `ir` types |

## How to read these documents

- **If you just want to see a real flow** → [`canonical-example.ff.ts`](./canonical-example.ff.ts).
  One complete, heavily-annotated `.ff.ts` that exercises every production in layer 2 and
  every rule in layer 4, with each block tagged by the grammar production and conformance
  rule it demonstrates. Start here, then drop into the formal docs when you need precision.
- **If you want to know "is this construct part of the DSL?"** → layer 2
  ([`flowforger-dsl.ebnf`](./flowforger-dsl.ebnf)). It tells you which statements the
  transformer lowers and which it ignores or dumps verbatim.
- **If you want to know "what tags can I put in a JSDoc comment, and in what form?"** →
  layer 3 ([`jsdoc-tags.ebnf`](./jsdoc-tags.ebnf)).
- **If you want to know "why did my flow compile but break at publish time?"** → layer 4
  ([`conformance.md`](./conformance.md)). These are the rules grammars can't catch.
- **If you want a contract you can validate against in code** → layer 5, the IR JSON Schema.

> **If you are an AI agent generating `.ff.ts` files:** read [`conformance.md`](./conformance.md)
> first (the 14 rules are the difference between "compiles" and "works"), then study
> [`canonical-example.ff.ts`](./canonical-example.ff.ts) as a template to imitate. Reach for the
> EBNFs only when you need the exact accepted form of a construct. For the *semantics* of each
> `ctx.*` method, connector operation, and worked patterns, see the concrete references below.

## The expression model in one paragraph

The conceptual heart of the DSL: aside from the constructs the EBNFs name explicitly,
**every TypeScript expression you write inside an action argument or condition is lowered
to a Power Automate expression string** by the expression-transformer. `ctx.body('X')?.['k']`
becomes `@body('X')?['k']`; `a === b` becomes `@equals(a, b)`; `x && y` becomes `@and(x, y)`.
Two forms exist with **different type behavior**: `@expr` (produced by direct `ctx.*` calls
and `ctx.eval('@...')`) **preserves the value's type** — array, object, number — while
`@{expr}` (produced by template literals, `ctx.braced(...)`, and `ctx.eval('@{...}')`)
**always coerces to a string**. Choosing `@{...}` for a value that must stay an array/object
is the single most common silent bug — see [conformance.md](./conformance.md) rule R10.

## Concrete references (semantics, not grammar)

The EBNFs say what *shapes* are legal; these say what the constructs *mean* and show worked
examples. They live with the authoring skill in [`skills/flowforger/`](../../skills/flowforger/):

- [`SKILL.md`](../../skills/flowforger/SKILL.md) — the canonical authoring rules (layer 4 is the spec-style restatement of these).
- [`dsl-syntax.md`](../../skills/flowforger/dsl-syntax.md) — every trigger, action, `ctx.*` method, and control-flow form with examples.
- [`connectors.md`](../../skills/flowforger/connectors.md) — connector operations and their parameter shapes.
- [`examples.md`](../../skills/flowforger/examples.md) — complete flow patterns.

**Checking your output:** the IR JSON Schema (layer 5) is machine-checkable. After transforming a
`.ff.ts` to IR, validate it with the CLI:

```bash
node packages/cli/dist/index.js validate <flow.ir.json>   # auto-detects IR vs Logic Apps format
```

## Why is there no single grammar file?

Because layer 1 is already TypeScript. FlowForger has no standalone parser; a `.ff.ts`
file is parsed by the TypeScript compiler, and the transformer
(`packages/dsl-native/src/transformer/` + `analyzers/`) together with the TypeScript type
checker *are* the operational grammar for layers 1–2. A from-scratch parseable grammar would
re-implement a TypeScript parser only to constrain it, and would drift from the transformer
it claims to describe.

So these documents pin down the parts that *are* finite and stable: the **output** (the IR
JSON Schema, layer 5 — authoritative and machine-checkable) and the **annotation language**
(layer 3). The recognized-subset EBNF (layer 2) and the conformance rules (layer 4) are
descriptive aids — useful for humans and for writing DSL diagnostics, with the transformer
as the source of truth.

## Status / authority

| Artifact | Authoritative? | Kept in sync by |
|----------|----------------|-----------------|
| `flowforger-ir.schema.json` | ✅ Yes | `npm run schema -w @flowforger/ir` (regenerated from types) |
| `jsdoc-tags.ebnf` | Near — mirrors the regexes in `analyzers/action-collector.ts` | Manual; update when a tag is added |
| `flowforger-dsl.ebnf` | ❌ Descriptive only | Manual; the transformer is the source of truth |
| `conformance.md` | ❌ Descriptive; each rule cites where it is enforced | Manual; mirrors `skills/flowforger/SKILL.md` |

> The recognized-subset EBNF and the JSDoc-tag EBNF describe behavior as of the transformer in
> `packages/dsl-native`. When you change the transformer or analyzers, update these docs (or
> the schema script for IR changes) in the same PR.
