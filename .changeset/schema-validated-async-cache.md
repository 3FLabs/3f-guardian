---
"@3flabs/guardian-defaults": minor
"@3flabs/guardian": patch
---

**Breaking (`@3flabs/guardian-defaults`):** `AsyncCache<V>` is now an abstract class with schema-validated reads instead of a 3-method interface.

- The constructor takes a schema — any [Standard Schema](https://standardschema.dev) (zod ≥ 3.24 / v4, valibot ≥ 1.0, arktype ≥ 2.0, …) — and the value type `V` is inferred from the schema's output.
- `get` is implemented by the base class: it performs a raw lookup via the new protected abstract `rawGet(key): Promise<unknown>` and runs every hit through the schema (`safeParse`-style, non-throwing). A stored value that fails to parse is reported as a **miss**, so a poisoned, truncated, or old-package-version entry can never reach a consumer as a typed hit. `set` / `delete` remain abstract.
- `inMemoryCache(options?)` is now `inMemoryCache(schema, options?)`.
- New export `zA1OnChainData` (from `./checks` and the root) — the zod schema for `A1OnChainData`, ready to pass to a cache constructor: `inMemoryCache(zA1OnChainData, { … })`.
- New type export `StandardSchemaV1` (from `./cache` and the root) for implementers typing their own adapters.

Migration: replace `inMemoryCache<T>(options)` with `inMemoryCache(schema, options)`, and convert hand-rolled `AsyncCache` object literals into subclasses providing `rawGet`/`set`/`delete`.

`@3flabs/guardian`: documentation-only sync (the `Eip712DomainCache` structural interface is unchanged and remains satisfied by `AsyncCache` instances).
