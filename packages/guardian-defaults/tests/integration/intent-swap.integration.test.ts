import { beforeAll, describe, expect, it } from "vitest";

import { ValidationFailedError } from "@3flabs/guardian";
import { type AddressBook, createIntegrationFixture } from "@3flabs/guardian-test-fixtures";

import { buildIntentSwapChecks, type IntentSwapPolicy } from "../../src/checks/intent-swap.js";
import { makeSigningContext } from "./_signing-context.js";

function policyFor(book: AddressBook): IntentSwapPolicy {
  return {
    maxDeadlineSecondsAhead: 600,
    acceptedPmFactories: new Map([[31337, new Set<string>([book.positionManagerFactory])]]),
    acceptedPmOwners: new Map([[31337, new Set<string>([book.accounts.owner.address])]]),
    // Empty PM has totalSupply=0; expectedDebt formula reduces to
    // `pmShares * (0 + 1) / (0 + virtualShareOffset)`. We pick equal
    // amounts so the price math is exact for any virtualShareOffset.
    swapPriceToleranceBps: 1,
  };
}

describe("§A.3 intent-swap — on-chain", () => {
  const fixture = createIntegrationFixture();
  beforeAll(fixture.setup);

  it("passes when one leg is a PositionManager from the accepted factory and prices match", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildIntentSwapChecks({ policy: policyFor(book) });

    // Match expected = pmShares * 1 / virtualShareOffset.
    // For an 18-decimal debt token, virtualShareOffset == 1, so expectedDebt == pmShares.
    const pmShares = 100n;
    const debtAmount = 100n;

    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      legs: [
        { intent: { id: "1" }, asset: book.positionManager, amount: pmShares.toString() },
        { intent: { id: "2" }, asset: book.tokens.debt, amount: debtAmount.toString() },
      ],
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isOk(), res.isErr() ? JSON.stringify(res.error) : "").toBe(true);
    if (!res.isOk()) return;
    for (const c of res.value) expect(c.passed, c.description).toBe(true);
  });

  it("fails when neither leg's asset is a PositionManager from an accepted factory", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const run = buildIntentSwapChecks({ policy: policyFor(book) });

    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      legs: [
        { intent: { id: "1" }, asset: book.tokens.collateral, amount: "100" },
        { intent: { id: "2" }, asset: book.tokens.debt, amount: "100" },
      ],
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isErr()).toBe(true);
    if (!res.isErr()) return;
    expect(res.error).toBeInstanceOf(ValidationFailedError);
  });

  it("fails when the PM owner is not on the accepted-owners list", async () => {
    const { book, clients } = fixture.snapshot();
    const ctx = makeSigningContext({ client: clients.publicClient, chainId: book.chainId });
    const policy: IntentSwapPolicy = {
      ...policyFor(book),
      acceptedPmOwners: new Map([
        [31337, new Set<string>(["0x000000000000000000000000000000000000dead"])],
      ]),
    };
    const run = buildIntentSwapChecks({ policy });

    const res = await run(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      legs: [
        { intent: { id: "1" }, asset: book.positionManager, amount: "100" },
        { intent: { id: "2" }, asset: book.tokens.debt, amount: "100" },
      ],
      deadline: Math.floor(Date.now() / 1000) + 300,
    });

    expect(res.isErr()).toBe(true);
    if (!res.isErr()) return;
    expect(res.error).toBeInstanceOf(ValidationFailedError);
  });
});
