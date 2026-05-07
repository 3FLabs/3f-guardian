/**
 * Generic, async, agnostic key-value cache interface used by the §A.1
 * (and transitively §A.4) on-chain reads.
 *
 * Implementations MUST:
 *   - Be safe to call concurrently for the same key (last write wins is
 *     acceptable; consumers tolerate redundant fetches on contention).
 *   - Honour the per-call `ttlMs` if supplied. Without `ttlMs`, the
 *     implementation may apply its own default (e.g. the in-memory
 *     impl's `defaultTtlMs`) or keep entries indefinitely.
 *   - Treat `undefined` as "miss". Distinguishing absent from expired is
 *     not required at the interface level — both should return
 *     `undefined`.
 *
 * Implementations MAY:
 *   - Throw on transport failures. Callers wrap `get` / `set` in
 *     try/catch and treat thrown errors as "miss" / "best-effort write"
 *     so a flaky cache never blocks an otherwise-valid request.
 *   - Persist values across processes (Redis, Memcached, KV) — values
 *     stored by `@3flabs/guardian-defaults` are designed to be
 *     JSON-serialisable provided callers convert `bigint` ↔ `string` at
 *     the adapter boundary. The bundled in-memory cache stores values
 *     by reference and does not need this.
 */
export interface AsyncCache<V> {
  /**
   * Look up `key`. Returns `undefined` for cache miss or expired entry.
   * Implementations SHOULD NOT distinguish miss from expiry — both
   * are observationally equivalent to the caller.
   */
  get(key: string): Promise<V | undefined>;

  /**
   * Store `value` under `key`. If `ttlMs` is provided, the entry MUST
   * expire after that many milliseconds; otherwise the implementation's
   * default policy applies.
   */
  set(key: string, value: V, options?: { ttlMs?: number }): Promise<void>;

  /**
   * Remove `key` if present. Idempotent: deleting a missing key is a
   * no-op.
   */
  delete(key: string): Promise<void>;
}
