import type { Result } from "better-result";

/**
 * Unwrap a `Result<T, E>` returned by an abstraction. On `Err` we throw the
 * inner error so the global onError handler maps it to a §6.5 envelope; on
 * `Ok` we return the value.
 *
 * Centralised so every route handler reads the same way.
 */
export function unwrapOrThrow<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
