import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, type Address } from "viem";

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

  it("classifies an EOA requestContract as a 422 factory failure, not a 503", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildIntentRequestBindingChecks({ policy: policyFor(book) });

    // An EOA has no code: `owner()` returns empty data and the stage-1
    // multicall decode fails deterministically. That is bad client
    // input, not an upstream outage — it must be a ValidationFailed
    // (422) on the factory check, never an UpstreamUnavailable (503).
    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.accounts.owner.address as Address, // an EOA
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isErr()).toBe(true);
    if (!res.isErr()) return;
    expect(res.error).toBeInstanceOf(ValidationFailedError);
    const factory = (res.error as ValidationFailedError).checks.find((c) =>
      c.description.includes("deployed by"),
    );
    expect(factory?.passed).toBe(false);
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

describe("§A.1 intent-request-binding — retargetter path, on-chain", () => {
  const fixture = createIntegrationFixture();
  beforeAll(fixture.setup);

  function retargetterPolicyFor(book: AddressBook): IntentRequestBindingPolicy {
    return {
      ...policyFor(book),
      acceptedRetargetters: new Map([[31337, new Set<string>([book.mockRetargetter])]]),
    };
  }

  it("keeps a retargetter-owned request on the classic path when no retargetter is listed", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildIntentRequestBindingChecks({ policy: policyFor(book) });

    // The retargetter's Request comes from the accepted factory, but its
    // owner / puller / consumer is the retargetter itself, which is on
    // none of the classic accepted sets.
    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.retargetterRequest,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isErr()).toBe(true);
    if (!res.isErr()) return;
    expect(res.error).toBeInstanceOf(ValidationFailedError);
    const owner = (res.error as ValidationFailedError).checks.find((c) =>
      c.description.includes("accepted-owners"),
    );
    expect(owner?.passed).toBe(false);
  });

  it("passes for the retargetter's attached request via its live operation()", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildIntentRequestBindingChecks({ policy: retargetterPolicyFor(book) });

    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.retargetterRequest,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isOk(), res.isErr() ? JSON.stringify(res.error) : "").toBe(true);
    if (!res.isOk()) return;
    for (const c of res.value) expect(c.passed, c.description).toBe(true);
    expect(res.value.map((c) => [c.description, c.skipped])).toEqual([
      ["owner of request contract is on the accepted-retargetters list", false],
      ["request contract was deployed by an accepted factory", true],
      ["owner of request contract is on the accepted-owners list", true],
      ["puller role on request contract is held only by accepted parties", true],
      ["consumer role on request contract is held only by accepted parties", true],
      ["request contract is the retargetter's attached operation request", false],
      [
        "retargetter repayment deadline is at least MIN_RETARGETTER_REPAYMENT_BUFFER ahead of now",
        false,
      ],
      ["deadline within MAX_DEADLINE_SECONDS_AHEAD of now", false],
    ]);
  });

  it("fails when the operation's repayment deadline is inside the buffer", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    // The fixture Request has ~90 days of runway; demand more than that.
    const run = buildIntentRequestBindingChecks({
      policy: {
        ...retargetterPolicyFor(book),
        minRetargetterRepaymentBufferSeconds: 91 * 24 * 3600,
      },
    });

    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.retargetterRequest,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isErr()).toBe(true);
    if (!res.isErr()) return;
    expect(res.error).toBeInstanceOf(ValidationFailedError);
    const buffer = (res.error as ValidationFailedError).checks.find((c) =>
      c.description.includes("MIN_RETARGETTER_REPAYMENT_BUFFER"),
    );
    expect(buffer?.passed).toBe(false);
  });

  // Mutates the mock's attachment — keep it last in this block.
  it("fails once the retargetter is attached to another request", async () => {
    const { book, clients } = fixture.snapshot();
    // `setOperation` is unauthenticated by design (see
    // contracts/MockRetargetter.sol); re-attach the retargetter to the
    // classic fixture Request so `book.retargetterRequest` is no longer
    // its operation request.
    const block = await clients.publicClient.getBlock();
    const tx = await clients.walletClient.sendTransaction({
      account: clients.walletClient.account!,
      to: book.mockRetargetter,
      data: encodeFunctionData({
        abi: parseAbi(["function setOperation(address,uint40)"]),
        functionName: "setOperation",
        args: [book.request, Number(block.timestamp) + 90 * 24 * 3600],
      }),
      chain: clients.walletClient.chain,
    });
    await clients.publicClient.waitForTransactionReceipt({ hash: tx });

    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildIntentRequestBindingChecks({ policy: retargetterPolicyFor(book) });

    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.retargetterRequest,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isErr()).toBe(true);
    if (!res.isErr()) return;
    expect(res.error).toBeInstanceOf(ValidationFailedError);
    const attached = (res.error as ValidationFailedError).checks.find((c) =>
      c.description.includes("attached operation request"),
    );
    expect(attached?.passed).toBe(false);
    expect(attached?.reason).toContain(book.request);
  });
});
