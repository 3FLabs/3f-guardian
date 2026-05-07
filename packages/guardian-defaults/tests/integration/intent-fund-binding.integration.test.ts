import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";

import { ValidationFailedError } from "@3flabs/guardian";
import { type AddressBook, createIntegrationFixture } from "@3flabs/guardian-test-fixtures";

import {
  buildIntentFundBindingChecks,
  type IntentFundBindingPolicy,
} from "../../src/checks/intent-fund-binding.js";
import { makeSigningContext } from "./_signing-context.js";

function policyFor(book: AddressBook): IntentFundBindingPolicy {
  return {
    maxDeadlineSecondsAhead: 600,
    acceptedFunds: new Map([[31337, new Set<string>([book.mockFund])]]),
    acceptedOwners: new Map([[31337, new Set<string>([book.accounts.owner.address])]]),
  };
}

describe("§A.2 intent-fund-binding — on-chain", () => {
  const fixture = createIntegrationFixture();
  beforeAll(fixture.setup);

  it("passes for an accepted fund whose Ownable.owner() is on the accepted-owners list", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildIntentFundBindingChecks({ policy: policyFor(book) });

    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      fundContract: book.mockFund,
      positionManager: book.positionManager,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isOk(), res.isErr() ? JSON.stringify(res.error) : "").toBe(true);
    if (!res.isOk()) return;
    for (const c of res.value) expect(c.passed, c.description).toBe(true);
  });

  it("fails when the fund's owner has been rotated to an unaccepted address", async () => {
    const { book, clients } = fixture.snapshot();
    // Rotate the OwnableMockFund owner to a rogue EOA
    const rogue = "0x000000000000000000000000000000000000dead" as const;
    const tx = await clients.walletClient.sendTransaction({
      account: book.accounts.owner.privateKey
        ? clients.walletClient.account!
        : clients.walletClient.account!,
      to: book.mockFund,
      data: encodeFunctionData({
        abi: parseAbi(["function setOwner(address)"]),
        functionName: "setOwner",
        args: [rogue],
      }),
      chain: clients.walletClient.chain,
    });
    await clients.publicClient.waitForTransactionReceipt({ hash: tx });

    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildIntentFundBindingChecks({ policy: policyFor(book) });

    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      fundContract: book.mockFund,
      positionManager: book.positionManager,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isErr()).toBe(true);
    if (!res.isErr()) return;
    expect(res.error).toBeInstanceOf(ValidationFailedError);
  });
});
