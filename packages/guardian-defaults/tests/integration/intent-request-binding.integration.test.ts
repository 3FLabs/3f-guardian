import { beforeAll, describe, expect, it } from "vitest";
import { type Address } from "viem";

import { ValidationFailedError } from "@3flabs/guardian";
import { type AddressBook, createIntegrationFixture } from "@3flabs/guardian-test-fixtures";

import {
  buildIntentRequestBindingChecks,
  type IntentRequestBindingPolicy,
} from "../../src/checks/intent-request-binding.js";
import { makeSigningContext } from "./_signing-context.js";

function policyFor(book: AddressBook): IntentRequestBindingPolicy {
  return {
    maxDeadlineSecondsAhead: 600,
    acceptedRequestFactories: new Map([[31337, new Set<string>([book.requestFactory])]]),
    acceptedOwners: new Map([[31337, new Set<string>([book.accounts.owner.address])]]),
    acceptedPullers: new Map([[31337, new Set<string>([book.accounts.puller.address])]]),
    acceptedConsumers: new Map([[31337, new Set<string>([book.accounts.consumer.address])]]),
    eventScanBlockRange: 1_000n,
    eventScanMaxLookbackBlocks: 100_000n,
  };
}

describe("§A.1 intent-request-binding — on-chain", () => {
  const fixture = createIntegrationFixture();
  beforeAll(fixture.setup);

  it("passes for a request minted by the accepted factory with the accepted owner / puller / consumer", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildIntentRequestBindingChecks({ policy: policyFor(book) });

    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.request,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isOk(), res.isErr() ? JSON.stringify(res.error) : "").toBe(true);
    if (!res.isOk()) return;
    for (const c of res.value) expect(c.passed, c.description).toBe(true);
  });

  it("fails when the request is NOT registered with any accepted factory (rogue contract)", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildIntentRequestBindingChecks({ policy: policyFor(book) });

    // The Facility itself is a contract, but it's not in the request factory's `_isRequest`
    // map and it's not Ownable in a way that satisfies our factory check.
    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.facility as Address, // not a Request from our factory
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isErr()).toBe(true);
    if (!res.isErr()) return;
    expect(res.error).toBeInstanceOf(ValidationFailedError);
  });

  it("fails when the puller is not on the accepted-pullers list", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const policy: IntentRequestBindingPolicy = {
      ...policyFor(book),
      acceptedPullers: new Map([
        [31337, new Set<string>(["0x000000000000000000000000000000000000dead"])],
      ]),
    };
    const run = buildIntentRequestBindingChecks({ policy });

    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.request,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isErr()).toBe(true);
    if (!res.isErr()) return;
    expect(res.error).toBeInstanceOf(ValidationFailedError);
  });
});
