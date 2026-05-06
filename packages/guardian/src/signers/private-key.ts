import { Result } from "better-result";
import type { Hex } from "viem";
import { signTypedData } from "viem/accounts";

import type { SignTypedData } from "../abstractions.js";
import { InternalError } from "../errors/tagged.js";

/**
 * Envelope around a raw 32-byte private key that produces a
 * {@link SignTypedData}. The key is captured once at construction and is
 * NEVER re-exposed: the returned function takes only the typed-data
 * payload and returns a `Result<Hex, ...>`.
 *
 * Backed by viem's `privateKeyToAccount(...).signTypedData(...)`. Local
 * EC math does not fail under normal circumstances; any thrown error is
 * surfaced as a `500 internal_error` since it indicates the local key is
 * in a broken state — an operator-grade incident, not a caller-
 * recoverable condition.
 *
 * Production deployments SHOULD prefer a KMS- or HSM-backed
 * implementation of {@link SignTypedData}; this envelope is intended for
 * development and tests.
 */
export function privateKeyToSignTypedData(privateKey: Hex): SignTypedData {
  return async (parameters) =>
    Result.tryPromise({
      try: () => signTypedData({ privateKey, ...parameters }),
      catch: (cause) =>
        new InternalError({
          message:
            cause instanceof Error
              ? `Local signTypedData failed: ${cause.message}`
              : "Local signTypedData failed",
        }),
    });
}
