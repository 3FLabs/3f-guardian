import { beforeAll, describe, expect, it } from "vitest";

import { ValidationFailedError } from "@3flabs/guardian";
import { type AddressBook, createIntegrationFixture } from "@3flabs/guardian-test-fixtures";

import {
  buildRequestWhitelistingChecks,
  type RequestWhitelistingPolicy,
} from "../../src/checks/request-whitelisting.js";
import { makeSigningContext } from "./_signing-context.js";

function policyFor(book: AddressBook): RequestWhitelistingPolicy {
  return {
    maxDeadlineSecondsAhead: 600,
    acceptedRequestFactories: new Map([[31337, new Set<string>([book.requestFactory])]]),
    acceptedOwners: new Map([[31337, new Set<string>([book.accounts.owner.address])]]),
    acceptedPullers: new Map([[31337, new Set<string>([book.accounts.puller.address])]]),
    acceptedConsumers: new Map([[31337, new Set<string>([book.accounts.consumer.address])]]),
    eventScanBlockRange: 1_000n,
    eventScanMaxLookbackBlocks: 100_000n,
    // Generous window — the floor is 0 on a fresh proxy.
    maxNonceAboveFloor: 1_000n,
  };
}

describe("§A.4 request-whitelisting — on-chain", () => {
  const fixture = createIntegrationFixture();
  beforeAll(fixture.setup);

  it("whitelist op passes against a real RequestWhitelist proxy at nonce == floor (== 0)", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    // The Guardian's signer here is validator1 (one of the validators stamped into the proxy
    // at init time). The runner reads `validatorNonceFloor(validator1) == 0` and
    // `isNonceConsumed(validator1, 0) == false`.
    const run = buildRequestWhitelistingChecks({
      policy: policyFor(book),
      guardianSigner: book.accounts.validator1.address,
    });

    const res = await run(ctx, {
      chainId: book.chainId,
      whitelistBook: book.whitelistBook,
      operation: "whitelist",
      requestContracts: [book.request],
      nonce: "0",
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isOk(), res.isErr() ? JSON.stringify(res.error) : "").toBe(true);
    if (!res.isOk()) return;
    for (const c of res.value) expect(c.passed, c.description).toBe(true);
  });

  it("unwhitelist op passes (skips per-contract §A.1) against the same proxy", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildRequestWhitelistingChecks({
      policy: policyFor(book),
      guardianSigner: book.accounts.validator2.address,
    });

    const res = await run(ctx, {
      chainId: book.chainId,
      whitelistBook: book.whitelistBook,
      operation: "unwhitelist",
      // Unwhitelist accepts any address — the §A.1 contract checks are skipped.
      requestContracts: [book.request, "0x000000000000000000000000000000000000dead"],
      nonce: "0",
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isOk(), res.isErr() ? JSON.stringify(res.error) : "").toBe(true);
  });

  it("fails when the request-side nonce window is exceeded (nonce > floor + maxNonceAboveFloor)", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildRequestWhitelistingChecks({
      policy: { ...policyFor(book), maxNonceAboveFloor: 0n },
      guardianSigner: book.accounts.validator1.address,
    });

    const res = await run(ctx, {
      chainId: book.chainId,
      whitelistBook: book.whitelistBook,
      operation: "unwhitelist",
      requestContracts: [book.request],
      nonce: "5",
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isErr()).toBe(true);
    if (!res.isErr()) return;
    expect(res.error).toBeInstanceOf(ValidationFailedError);
  });
});
