import type { StandardSchemaV1 } from "./standard-schema.js";

/**
 * Generic, async, schema-validated key-value cache used by the §A.1
 * (and transitively §A.4) on-chain reads.
 *
 * `AsyncCache` is an abstract class. The base class owns the read
 * path: `get` performs a raw lookup via the implementation's
 * {@link AsyncCache.rawGet | rawGet} and runs every hit through the
 * schema supplied at construction. Validation is non-throwing
 * (`safeParse`-style) and a value that fails to parse is reported as a
 * MISS — a poisoned, truncated, or schema-incompatible entry (e.g.
 * written by an older package version into a shared Redis) can never
 * reach a consumer as a typed hit. The value type `V` is inferred from
 * the schema's output type.
 *
 * The schema is any Standard Schema v1 (https://standardschema.dev):
 * zod ≥ 3.24 / v4, valibot ≥ 1.0, arktype ≥ 2.0, … all qualify, so
 * `new MyCache(z.object({ … }))` works without this package depending
 * on a specific validation library.
 *
 * The schema MUST be idempotent over its own output: `set` stores `V`
 * (the schema's OUTPUT type), and `get` re-validates exactly that
 * shape, so the output must itself parse. A transforming schema whose
 * output no longer satisfies its input (e.g. `z.string().transform(s
 * => s.length)`) silently disables the cache — every hit fails
 * validation and reads as a miss — and one whose transform is
 * re-applicable (e.g. doubling a number) would re-run it on every
 * read. Pure validation schemas like `zA1OnChainData` are always safe.
 *
 * Implementations MUST:
 *   - Be safe to call concurrently for the same key (last write wins is
 *     acceptable; consumers tolerate redundant fetches on contention).
 *   - Honour the per-call `ttlMs` if supplied. Without `ttlMs`, the
 *     implementation may apply its own default (e.g. the in-memory
 *     impl's `defaultTtlMs`) or keep entries indefinitely.
 *   - Return `undefined` from `rawGet` for "miss". Distinguishing
 *     absent from expired is not required — both should return
 *     `undefined`.
 *
 * Implementations MAY:
 *   - Throw on transport failures. Callers wrap `get` / `set` in
 *     try/catch and treat thrown errors as "miss" / "best-effort write"
 *     so a flaky cache never blocks an otherwise-valid request.
 *   - Persist values across processes (Redis, Memcached, KV) — values
 *     stored by `@3flabs/guardian-defaults` are designed to be
 *     JSON-serialisable provided the adapter converts `bigint` ↔
 *     `string` and `Map` ↔ entries at its own boundary. `rawGet` must
 *     return the *revived* domain shape; the schema then decides
 *     whether the round-trip survived. The bundled in-memory cache
 *     stores values by reference and does not need this.
 */
export abstract class AsyncCache<V> {
  /**
   * Schema applied to every raw hit on the `get` path. Stored from the
   * constructor argument; subclasses may reuse it (e.g. to validate on
   * the write path too), but the base class only consults it in `get`.
   */
  protected readonly schema: StandardSchemaV1<unknown, V>;

  constructor(schema: StandardSchemaV1<unknown, V>) {
    this.schema = schema;
  }

  /**
   * Look up `key`. Returns `undefined` for a cache miss, an expired
   * entry, OR a stored value that fails schema validation — all three
   * are observationally equivalent to the caller, which falls back to
   * the authoritative fetch and overwrites the entry via `set`.
   *
   * A validation failure additionally (a) notifies
   * {@link AsyncCache.onValidationFailure | onValidationFailure} and
   * (b) best-effort deletes the entry, so a poisoned value in a shared
   * store doesn't sit there turning every read into a full
   * authoritative refetch until its TTL expires.
   */
  async get(key: string): Promise<V | undefined> {
    const raw = await this.rawGet(key);
    if (raw === undefined) return undefined;
    let result = this.schema["~standard"].validate(raw);
    if (result instanceof Promise) result = await result;
    if (result.issues) {
      this.onValidationFailure(key, result.issues);
      try {
        await this.delete(key);
      } catch {
        // Best-effort purge; the read already reports a miss.
      }
      return undefined;
    }
    return result.value;
  }

  /**
   * Observability hook invoked when a stored value fails schema
   * validation on the read path. The base implementation is a no-op —
   * the failure direction is safe (miss → authoritative refetch) — but
   * silent failures hide active cache poisoning and the resulting load
   * amplification from operators, so implementations SHOULD override
   * this with a log line or metric. A thrown error here is the
   * subclass's own bug and intentionally not swallowed.
   */
  protected onValidationFailure(
    _key: string,
    _issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ): void {}

  /**
   * Raw storage lookup. Returns whatever the backing store holds for
   * `key` — `undefined` for miss/expired — WITHOUT validating it. The
   * base class's `get` owns validation; implementations must not
   * narrow the return type themselves.
   */
  protected abstract rawGet(key: string): Promise<unknown>;

  /**
   * Store `value` under `key`. If `ttlMs` is provided, the entry MUST
   * expire after that many milliseconds; otherwise the implementation's
   * default policy applies.
   */
  abstract set(key: string, value: V, options?: { ttlMs?: number }): Promise<void>;

  /**
   * Remove `key` if present. Idempotent: deleting a missing key is a
   * no-op.
   */
  abstract delete(key: string): Promise<void>;
}
