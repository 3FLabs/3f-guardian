/**
 * Sibling of {@link _signing-context.ts} that wires a real
 * {@link privateKeyToSignTypedData} signer instead of the throwing
 * stub. Used by the e2e tests in `e2e-sign-runners.integration.test.ts`
 * where the full flow `checks → sign → broadcast` runs against a
 * deployed Guardian stack.
 */

import type { Hex, PublicClient } from "viem";

import { noopLogger, privateKeyToSignTypedData, type SigningContext } from "@3flabs/guardian";

export function makeE2eSigningContext(args: {
  client: PublicClient;
  privateKey: Hex;
  chainId: number;
  now?: Date;
}): SigningContext {
  return {
    chainId: args.chainId,
    client: args.client,
    requestId: "e2e-req",
    tokenId: "e2e-token",
    now: args.now ?? new Date(),
    signTypedData: privateKeyToSignTypedData(args.privateKey),
    logger: noopLogger,
  };
}
