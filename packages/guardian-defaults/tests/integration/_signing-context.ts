/**
 * Helper that turns a per-test viem `publicClient` into a
 * `SigningContext` the check runners (and sign-runners) consume. The
 * `signTypedData` here is a no-op since the §A integration tests
 * exercise the *check* runners, not the sign-runners — those are
 * tested in `@3flabs/guardian/tests/integration/sign-runners`.
 */

import type { PublicClient } from "viem";

import { noopLogger, type SigningContext } from "@3flabs/guardian";

export function makeSigningContext(args: {
  client: PublicClient;
  chainId: number;
  now?: Date;
}): SigningContext {
  return {
    chainId: args.chainId,
    client: args.client,
    requestId: "test-req",
    tokenId: "test-token",
    now: args.now ?? new Date(),
    signTypedData: async () => {
      throw new Error("makeSigningContext: signTypedData not used by check-runner tests");
    },
    logger: noopLogger,
  };
}
