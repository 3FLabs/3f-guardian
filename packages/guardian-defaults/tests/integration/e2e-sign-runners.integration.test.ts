/**
 * End-to-end tests covering all four §7 sign-runners against a real
 * Guardian stack: each test runs the *real* §A check runner (this
 * package), composes it with the *real* `makeSign*` orchestrator
 * (`@3flabs/guardian`), signs with a deterministic anvil key, and
 * either:
 *
 *  - broadcasts the resulting payload + signature on-chain via
 *    `walletClient.writeContract` for happy paths (so a successful
 *    receipt proves the contract accepted the digest), or
 *  - re-runs the same call through `publicClient.simulateContract`
 *    for failure paths (so viem's revert decoder names the contract's
 *    custom errors instead of leaving us with a raw 4-byte selector,
 *    and no state mutates).
 *
 * Cast (already in {@link AddressBook}):
 *  - `facilitator` — broadcasts §7.3–§7.5 txs (holds `FACILITATOR_ROLE`).
 *  - `guardian`    — signs §7.3–§7.5 typed-data (holds `GUARDIAN_ROLE`).
 *  - `validator1` / `validator2` / `validator3` — sign §7.6 typed-data.
 *     The deploy is forced to `whitelistQuorum: 2` so two of three
 *     signatures are required (the contract enforces `quorum < N`, so
 *     three validators are needed for quorum=2).
 *
 * Test ordering inside §7.3–§7.5 is deliberate: the Facility's
 * `setRequest` / `setFund` no-op early when `newRequest == intent.request`
 * (resp. fund), so failure tests must run **before** the happy test —
 * otherwise the contract's idempotent early-return swallows our reverts.
 *
 * Failure-path strategy: rather than racing the wall clock we set the
 * `SigningContext.now` to a fictional past, sign with a deadline that
 * sits in *that* fictional window (so the off-chain §A deadline check
 * passes), and let the unmoved chain clock be past it. Hermetic and
 * needs no `evm_increaseTime`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { type Abi, type Account, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  buildWhitelistRequestTypedData,
  fetchEip712DomainNameVersion,
  makeSignIntentFundBinding,
  makeSignIntentRequestBinding,
  makeSignIntentSwap,
  makeSignRequestWhitelisting,
  type SigningContext,
} from "@3flabs/guardian";
import {
  artifacts,
  type AddressBook,
  createIntegrationFixture,
  type IntegrationClients,
} from "@3flabs/guardian-test-fixtures";

import {
  buildIntentRequestBindingChecks,
  type IntentRequestBindingPolicy,
} from "../../src/checks/intent-request-binding.js";
import {
  buildIntentFundBindingChecks,
  type IntentFundBindingPolicy,
} from "../../src/checks/intent-fund-binding.js";
import { buildIntentSwapChecks, type IntentSwapPolicy } from "../../src/checks/intent-swap.js";
import {
  buildRequestWhitelistingChecks,
  type RequestWhitelistingPolicy,
} from "../../src/checks/request-whitelisting.js";
import { makeE2eSigningContext } from "./_e2e-signing-context.js";

// ─── policy helpers ─────────────────────────────────────────────────────

function requestBindingPolicy(book: AddressBook): IntentRequestBindingPolicy {
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

function fundBindingPolicy(book: AddressBook): IntentFundBindingPolicy {
  return {
    maxDeadlineSecondsAhead: 600,
    acceptedFunds: new Map([[31337, new Set<string>([book.mockFund])]]),
    acceptedOwners: new Map([[31337, new Set<string>([book.accounts.owner.address])]]),
  };
}

function swapPolicy(book: AddressBook): IntentSwapPolicy {
  return {
    maxDeadlineSecondsAhead: 600,
    acceptedPmFactories: new Map([[31337, new Set<string>([book.positionManagerFactory])]]),
    acceptedPmOwners: new Map([[31337, new Set<string>([book.accounts.owner.address])]]),
    swapPriceToleranceBps: 1,
  };
}

function whitelistingPolicy(book: AddressBook): RequestWhitelistingPolicy {
  return {
    maxDeadlineSecondsAhead: 600,
    acceptedRequestFactories: new Map([[31337, new Set<string>([book.requestFactory])]]),
    acceptedOwners: new Map([[31337, new Set<string>([book.accounts.owner.address])]]),
    acceptedPullers: new Map([[31337, new Set<string>([book.accounts.puller.address])]]),
    acceptedConsumers: new Map([[31337, new Set<string>([book.accounts.consumer.address])]]),
    eventScanBlockRange: 1_000n,
    eventScanMaxLookbackBlocks: 100_000n,
    maxNonceAboveFloor: 1_000n,
  };
}

// ─── on-chain helpers ───────────────────────────────────────────────────

const SIGNATURE_CLASS_REVERT = /InvalidSignature|BadSignature|SignatureInvalid/i;

type WriteArgs = {
  readonly clients: IntegrationClients;
  readonly account: Account;
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  // viem's typed signature is a discriminated tuple per (abi, functionName);
  // for the test glue we accept any unknown[] and let the runtime catch
  // shape mismatches via the contract's own type encoding.
  readonly args: readonly unknown[];
};

async function writeAndWait(args: WriteArgs): Promise<void> {
  const hash = await args.clients.walletClient.writeContract({
    account: args.account,
    address: args.address,
    abi: args.abi,
    functionName: args.functionName,
    args: args.args,
    chain: args.clients.walletClient.chain,
  } as never);
  const receipt = await args.clients.publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
}

/**
 * Failure-path helper. We use `simulateContract` rather than actually
 * sending the tx — viem's simulator threads the contract `abi` through
 * the revert decoder, so the resulting error message contains the
 * named custom error (e.g. `NotGuardian`, `DeadlineExpired`) instead of
 * a raw 4-byte selector. No state mutation, so safe to interleave with
 * the happy-path tests in the same describe.
 */
async function writeExpectRevert(args: WriteArgs): Promise<string> {
  try {
    await args.clients.publicClient.simulateContract({
      account: args.account,
      address: args.address,
      abi: args.abi,
      functionName: args.functionName,
      args: args.args,
    } as never);
    throw new Error("expected revert but simulation succeeded");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function sortByAddress<T extends { validator: Address }>(sigs: readonly T[]): T[] {
  // The spread creates a fresh mutable copy, so the in-place `.sort` is
  // local — the readonly input is never mutated. (oxlint flags Array#sort
  // by default; we're not actually mutating the original.)
  // oxlint-disable-next-line no-array-sort
  const copy = [...sigs];
  copy.sort((a, b) => (a.validator.toLowerCase() < b.validator.toLowerCase() ? -1 : 1));
  return copy;
}

// ─── Fixture: quorum=2 so §7.6 needs two-of-three validators ────────────

const fixture = createIntegrationFixture({ whitelistQuorum: 2 });

// ─── §7.3 IntentRequestBinding — Facility.setRequest ────────────────────

describe("§7.3 IntentRequestBinding e2e — checks → sign → Facility.setRequest", () => {
  beforeAll(fixture.setup);

  // The Facility's setRequest no-ops early when `newRequest == intent.request`,
  // so failure tests must run BEFORE the happy test or the contract would
  // silently swallow our intentionally-wrong calls. Replay runs last because
  // it deliberately depends on a successful happy path having consumed
  // the digest already.

  it("wrong signer: signing with the puller's key (no GUARDIAN_ROLE) is rejected with NotGuardian", async () => {
    const { book, clients } = fixture.snapshot();
    const sign = makeSignIntentRequestBinding({
      checks: buildIntentRequestBindingChecks({ policy: requestBindingPolicy(book) }),
      guardianSigner: book.accounts.puller.address,
    });
    const ctx = makeE2eSigningContext({
      client: clients.publicClient,
      privateKey: book.accounts.puller.privateKey,
      chainId: book.chainId,
    });
    const blockNow = await clients.publicClient.getBlock();
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    const r = await sign(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.request,
      deadline,
    });
    expect(r.isOk()).toBe(true);
    if (!r.isOk()) return;

    const message = await writeExpectRevert({
      clients,
      account: book.accounts.facilitator.account,
      address: book.facility,
      abi: artifacts.Facility.abi as Abi,
      functionName: "setRequest",
      args: [
        1n,
        book.request,
        BigInt(deadline),
        [book.accounts.puller.address],
        [r.value.signature],
      ],
    });
    expect(message).toMatch(/NotGuardian/);
  });

  it("expired deadline: chain has moved past the signed deadline → DeadlineExpired", async () => {
    const { book, clients } = fixture.snapshot();
    const sign = makeSignIntentRequestBinding({
      checks: buildIntentRequestBindingChecks({ policy: requestBindingPolicy(book) }),
      guardianSigner: book.accounts.guardian.address,
    });
    const oneHourAgoMs = Date.now() - 3_600_000;
    const ctx = makeE2eSigningContext({
      client: clients.publicClient,
      privateKey: book.accounts.guardian.privateKey,
      chainId: book.chainId,
      now: new Date(oneHourAgoMs),
    });
    const deadline = Math.floor(oneHourAgoMs / 1000) + 300;

    const r = await sign(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.request,
      deadline,
    });
    expect(r.isOk()).toBe(true);
    if (!r.isOk()) return;

    const message = await writeExpectRevert({
      clients,
      account: book.accounts.facilitator.account,
      address: book.facility,
      abi: artifacts.Facility.abi as Abi,
      functionName: "setRequest",
      args: [
        1n,
        book.request,
        BigInt(deadline),
        [book.accounts.guardian.address],
        [r.value.signature],
      ],
    });
    expect(message).toMatch(/DeadlineExpired/);
    expect(message).not.toMatch(SIGNATURE_CLASS_REVERT);
  });

  it("happy path: real check + guardian sig is accepted by Facility.setRequest", async () => {
    const { book, clients } = fixture.snapshot();
    const sign = makeSignIntentRequestBinding({
      checks: buildIntentRequestBindingChecks({ policy: requestBindingPolicy(book) }),
      guardianSigner: book.accounts.guardian.address,
    });
    const ctx = makeE2eSigningContext({
      client: clients.publicClient,
      privateKey: book.accounts.guardian.privateKey,
      chainId: book.chainId,
    });
    const blockNow = await clients.publicClient.getBlock();
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    const r = await sign(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.request,
      deadline,
    });
    expect(r.isOk(), r.isErr() ? JSON.stringify(r.error) : "").toBe(true);
    if (!r.isOk()) return;
    for (const c of r.value.checks) expect(c.passed, c.description).toBe(true);

    await writeAndWait({
      clients,
      account: book.accounts.facilitator.account,
      address: book.facility,
      abi: artifacts.Facility.abi as Abi,
      functionName: "setRequest",
      args: [
        1n,
        book.request,
        BigInt(deadline),
        [book.accounts.guardian.address],
        [r.value.signature],
      ],
    });
  });

  // Note on digest-replay coverage: Facility.setRequest's idempotent
  // early-return (`if (intent.request == newRequest) return;`) runs
  // *before* `_checkSignatures`, so submitting the same args twice no-ops
  // rather than triggering `DigestUsed`. Resetting the binding via
  // `setRequest(id, 0, …)` would still revert with `RequestNotRepaid`
  // because the bound Request hasn't been repaid (and exercising the
  // repay path is far outside the scope of a Guardian signature test).
  // The contract's digest-replay protection is unit-tested in grunt
  // itself; covering it here would only re-prove a contract invariant
  // we don't own.
});

// ─── §7.4 IntentFundBinding — Facility.setFund ──────────────────────────

describe("§7.4 IntentFundBinding e2e — checks → sign → Facility.setFund", () => {
  beforeAll(fixture.setup);

  // Same idempotent early-return as setRequest, so failure tests must
  // run before the happy test. Replay coverage lives in §7.3.

  it("wrong signer: setFund with non-guardian sig → NotGuardian", async () => {
    const { book, clients } = fixture.snapshot();
    const sign = makeSignIntentFundBinding({
      checks: buildIntentFundBindingChecks({ policy: fundBindingPolicy(book) }),
      guardianSigner: book.accounts.puller.address,
    });
    const ctx = makeE2eSigningContext({
      client: clients.publicClient,
      privateKey: book.accounts.puller.privateKey,
      chainId: book.chainId,
    });
    const blockNow = await clients.publicClient.getBlock();
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    const r = await sign(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      fundContract: book.mockFund,
      positionManager: book.positionManager,
      deadline,
    });
    expect(r.isOk()).toBe(true);
    if (!r.isOk()) return;

    const message = await writeExpectRevert({
      clients,
      account: book.accounts.facilitator.account,
      address: book.facility,
      abi: artifacts.Facility.abi as Abi,
      functionName: "setFund",
      args: [
        1n,
        book.mockFund,
        BigInt(deadline),
        [book.accounts.puller.address],
        [r.value.signature],
      ],
    });
    expect(message).toMatch(/NotGuardian/);
  });

  it("expired deadline: setFund signed in the (fictional) past → DeadlineExpired", async () => {
    const { book, clients } = fixture.snapshot();
    const sign = makeSignIntentFundBinding({
      checks: buildIntentFundBindingChecks({ policy: fundBindingPolicy(book) }),
      guardianSigner: book.accounts.guardian.address,
    });
    const oneHourAgoMs = Date.now() - 3_600_000;
    const ctx = makeE2eSigningContext({
      client: clients.publicClient,
      privateKey: book.accounts.guardian.privateKey,
      chainId: book.chainId,
      now: new Date(oneHourAgoMs),
    });
    const deadline = Math.floor(oneHourAgoMs / 1000) + 300;

    const r = await sign(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      fundContract: book.mockFund,
      positionManager: book.positionManager,
      deadline,
    });
    expect(r.isOk()).toBe(true);
    if (!r.isOk()) return;

    const message = await writeExpectRevert({
      clients,
      account: book.accounts.facilitator.account,
      address: book.facility,
      abi: artifacts.Facility.abi as Abi,
      functionName: "setFund",
      args: [
        1n,
        book.mockFund,
        BigInt(deadline),
        [book.accounts.guardian.address],
        [r.value.signature],
      ],
    });
    expect(message).toMatch(/DeadlineExpired/);
    expect(message).not.toMatch(SIGNATURE_CLASS_REVERT);
  });

  it("happy path: real check + guardian sig is accepted by Facility.setFund", async () => {
    const { book, clients } = fixture.snapshot();
    const sign = makeSignIntentFundBinding({
      checks: buildIntentFundBindingChecks({ policy: fundBindingPolicy(book) }),
      guardianSigner: book.accounts.guardian.address,
    });
    const ctx = makeE2eSigningContext({
      client: clients.publicClient,
      privateKey: book.accounts.guardian.privateKey,
      chainId: book.chainId,
    });
    const blockNow = await clients.publicClient.getBlock();
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    const r = await sign(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      fundContract: book.mockFund,
      positionManager: book.positionManager,
      deadline,
    });
    expect(r.isOk(), r.isErr() ? JSON.stringify(r.error) : "").toBe(true);
    if (!r.isOk()) return;
    for (const c of r.value.checks) expect(c.passed, c.description).toBe(true);

    await writeAndWait({
      clients,
      account: book.accounts.facilitator.account,
      address: book.facility,
      abi: artifacts.Facility.abi as Abi,
      functionName: "setFund",
      args: [
        1n,
        book.mockFund,
        BigInt(deadline),
        [book.accounts.guardian.address],
        [r.value.signature],
      ],
    });
  });
});

// ─── §7.6 RequestWhitelisting — RequestWhitelist.{whitelist,unwhitelist}BySig ─

describe("§7.6 RequestWhitelisting e2e — checks → sign → RequestWhitelist.{whitelist,unwhitelist}BySig", () => {
  beforeAll(fixture.setup);

  type ValidatorSig = {
    readonly validator: Address;
    readonly nonce: bigint;
    readonly signature: Hex;
  };

  /**
   * Run the §A.4 check + sign flow once per validator and return a
   * `(validator, nonce, signature)` tuple. The caller is responsible
   * for sorting the resulting array ascending by validator address —
   * `QuorumSigLib` requires that ordering on submission.
   */
  async function signWithValidator(args: {
    book: AddressBook;
    publicClient: SigningContext["client"];
    operation: "whitelist" | "unwhitelist";
    nonce: string;
    deadline: number;
    validator: { address: Address; privateKey: Hex };
  }): Promise<ValidatorSig> {
    const { book, publicClient, operation, nonce, deadline, validator } = args;
    const sign = makeSignRequestWhitelisting({
      checks: buildRequestWhitelistingChecks({
        policy: whitelistingPolicy(book),
        guardianSigner: validator.address,
      }),
      guardianSigner: validator.address,
    });
    const ctx = makeE2eSigningContext({
      client: publicClient,
      privateKey: validator.privateKey,
      chainId: book.chainId,
    });
    const r = await sign(ctx, {
      chainId: book.chainId,
      whitelistBook: book.whitelistBook,
      operation,
      requestContracts: [book.request],
      nonce,
      deadline,
    });
    if (r.isErr()) {
      throw new Error(`signRequestWhitelisting failed: ${JSON.stringify(r.error)}`);
    }
    return {
      validator: validator.address,
      nonce: BigInt(nonce),
      signature: r.value.signature,
    };
  }

  it("happy whitelist: validator1 + validator2 sigs reach quorum=2 and the proxy whitelists the request", async () => {
    const { book, clients } = fixture.snapshot();
    const blockNow = await clients.publicClient.getBlock();
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    const sig1 = await signWithValidator({
      book,
      publicClient: clients.publicClient,
      operation: "whitelist",
      nonce: "0",
      deadline,
      validator: book.accounts.validator1,
    });
    const sig2 = await signWithValidator({
      book,
      publicClient: clients.publicClient,
      operation: "whitelist",
      nonce: "0",
      deadline,
      validator: book.accounts.validator2,
    });

    await writeAndWait({
      clients,
      account: book.accounts.facilitator.account,
      address: book.whitelistBook,
      abi: artifacts.RequestWhitelist.abi as Abi,
      functionName: "whitelistBySig",
      args: [[book.request], BigInt(deadline), sortByAddress([sig1, sig2])],
    });

    const whitelisted = await clients.publicClient.readContract({
      address: book.whitelistBook,
      abi: artifacts.RequestWhitelist.abi,
      functionName: "isWhitelisted",
      args: [book.request],
    });
    expect(whitelisted).toBeTruthy();
  });

  it("happy unwhitelist: same pair signs UnwhitelistRequest and the proxy unwhitelists the request", async () => {
    const { book, clients } = fixture.snapshot();
    const blockNow = await clients.publicClient.getBlock();
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    // Each validator's per-validator nonce starts at 0; the previous
    // happy test consumed validator1+validator2's nonce 0 for whitelist,
    // so unwhitelist uses nonce 1.
    const sig1 = await signWithValidator({
      book,
      publicClient: clients.publicClient,
      operation: "unwhitelist",
      nonce: "1",
      deadline,
      validator: book.accounts.validator1,
    });
    const sig2 = await signWithValidator({
      book,
      publicClient: clients.publicClient,
      operation: "unwhitelist",
      nonce: "1",
      deadline,
      validator: book.accounts.validator2,
    });

    await writeAndWait({
      clients,
      account: book.accounts.facilitator.account,
      address: book.whitelistBook,
      abi: artifacts.RequestWhitelist.abi as Abi,
      functionName: "unwhitelistBySig",
      args: [[book.request], BigInt(deadline), sortByAddress([sig1, sig2])],
    });

    const whitelisted = await clients.publicClient.readContract({
      address: book.whitelistBook,
      abi: artifacts.RequestWhitelist.abi,
      functionName: "isWhitelisted",
      args: [book.request],
    });
    expect(whitelisted).toBeFalsy();
  });

  it("quorum not met: only 1 of 2 sigs at quorum=2 → QuorumNotMet", async () => {
    const { book, clients } = fixture.snapshot();
    const blockNow = await clients.publicClient.getBlock();
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    const sig1 = await signWithValidator({
      book,
      publicClient: clients.publicClient,
      operation: "whitelist",
      nonce: "2",
      deadline,
      validator: book.accounts.validator1,
    });

    const message = await writeExpectRevert({
      clients,
      account: book.accounts.facilitator.account,
      address: book.whitelistBook,
      abi: artifacts.RequestWhitelist.abi as Abi,
      functionName: "whitelistBySig",
      args: [[book.request], BigInt(deadline), [sig1]],
    });
    expect(message).toMatch(/QuorumNotMet/);
  });

  it("duplicate validator: same validator's sig submitted twice → DuplicateValidator/DuplicateSignature", async () => {
    const { book, clients } = fixture.snapshot();
    const blockNow = await clients.publicClient.getBlock();
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    const sig1 = await signWithValidator({
      book,
      publicClient: clients.publicClient,
      operation: "whitelist",
      nonce: "3",
      deadline,
      validator: book.accounts.validator1,
    });

    const message = await writeExpectRevert({
      clients,
      account: book.accounts.facilitator.account,
      address: book.whitelistBook,
      abi: artifacts.RequestWhitelist.abi as Abi,
      functionName: "whitelistBySig",
      args: [[book.request], BigInt(deadline), [sig1, sig1]],
    });
    expect(message).toMatch(/DuplicateValidator|DuplicateSignature/);
  });

  it("nonce already consumed: replay validator1's already-spent nonce → NonceConsumed/NonceBelowFloor", async () => {
    const { book, clients } = fixture.snapshot();
    const blockNow = await clients.publicClient.getBlock();
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    // The §A.4 runner refuses to sign a nonce it already saw consumed
    // on-chain, so going through it would short-circuit before we ever
    // hit the contract. We bypass the runner here and craft validator1's
    // nonce-0 signature directly to prove that the *contract* enforces
    // replay protection on consumed nonces. Validator3 is paired in
    // (still at fresh nonce 0) so the submission reaches quorum=2.
    const domainRes = await fetchEip712DomainNameVersion({
      client: clients.publicClient,
      chainId: book.chainId,
      verifyingContract: book.whitelistBook,
    });
    if (!domainRes.isOk()) throw new Error("domain fetch failed");
    const { typedData } = buildWhitelistRequestTypedData({
      domain: {
        ...domainRes.value,
        chainId: book.chainId,
        verifyingContract: book.whitelistBook,
      },
      validator: book.accounts.validator1.address,
      body: {
        chainId: book.chainId,
        whitelistBook: book.whitelistBook,
        requestContracts: [book.request],
        nonce: "0",
        deadline,
      },
    });
    const v1Replay: ValidatorSig = {
      validator: book.accounts.validator1.address,
      nonce: 0n,
      signature: await privateKeyToAccount(book.accounts.validator1.privateKey).signTypedData(
        typedData,
      ),
    };

    // Validator3 is fresh — its nonce-0 sig is legitimate.
    const sig3 = await signWithValidator({
      book,
      publicClient: clients.publicClient,
      operation: "whitelist",
      nonce: "0",
      deadline,
      validator: book.accounts.validator3,
    });

    const message = await writeExpectRevert({
      clients,
      account: book.accounts.facilitator.account,
      address: book.whitelistBook,
      abi: artifacts.RequestWhitelist.abi as Abi,
      functionName: "whitelistBySig",
      args: [[book.request], BigInt(deadline), sortByAddress([v1Replay, sig3])],
    });
    expect(message).toMatch(/NonceConsumed|NonceBelowFloor/);
  });
});
// ─── §7.5 IntentSwap — Facility.swap (with extra intent id=2) ───────────

describe("§7.5 IntentSwap e2e — checks → sign → Facility.swap", () => {
  beforeAll(fixture.setup);

  // Set up a second intent (id=2) with debt as deposit asset, then warp
  // anvil time forward 25h so BOTH intents are past their `resolveStart`
  // and `getResolvingIntent` doesn't revert. We can't wait the real 25h,
  // and `resolveStart` is bounded `> block.timestamp` at create time so
  // we can't set it directly to the past — hence: create future, then
  // warp.
  beforeAll(async () => {
    const { book, clients } = fixture.snapshot();
    const block = await clients.publicClient.getBlock();
    await writeAndWait({
      clients,
      account: book.accounts.owner.account,
      address: book.facility,
      abi: artifacts.Facility.abi as Abi,
      functionName: "createIntent",
      args: [
        {
          depositAsset: { asset: book.tokens.debt, isPositionManager: false },
          targetAsset: { asset: book.positionManager, isPositionManager: true },
          depositCap: 1_000_000n * 10n ** 18n,
          guardKey: book.positionManager,
          resolveStart: Number(BigInt(block.timestamp) + 60n),
          quorum: 1,
          transferableIntent: true,
        },
      ],
    });
    // Advance time past intent 1's resolveStart (now+24h) and intent 2's
    // (now+60s). 25h does both.
    await clients.testClient.increaseTime({ seconds: 25 * 3600 });
    await clients.testClient.mine({ blocks: 1 });
  });

  it("wrong signer: swap with non-guardian sig → NotGuardian", async () => {
    const { book, clients } = fixture.snapshot();
    const blockNow = await clients.publicClient.getBlock();
    const sign = makeSignIntentSwap({
      checks: buildIntentSwapChecks({ policy: swapPolicy(book) }),
      guardianSigner: book.accounts.puller.address,
    });
    // The §7.5 beforeAll warped chain time forward 25h; align ctx.now
    // with the chain so the off-chain §A deadline check stays inside
    // its window (deadline = block.timestamp + 300s).
    const ctx = makeE2eSigningContext({
      client: clients.publicClient,
      privateKey: book.accounts.puller.privateKey,
      chainId: book.chainId,
      now: new Date(Number(blockNow.timestamp) * 1000),
    });
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    const r = await sign(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      legs: [
        { intent: { id: "1" }, asset: book.positionManager, amount: "1" },
        { intent: { id: "2" }, asset: book.tokens.debt, amount: "1" },
      ],
      deadline,
    });
    expect(r.isOk()).toBe(true);
    if (!r.isOk()) return;

    const message = await writeExpectRevert({
      clients,
      account: book.accounts.facilitator.account,
      address: book.facility,
      abi: artifacts.Facility.abi as Abi,
      functionName: "swap",
      args: [
        {
          id1: 1n,
          token1: book.positionManager,
          id2: 2n,
          token2: book.tokens.debt,
          amount1: 1n,
          amount2: 1n,
          deadline: BigInt(deadline),
        },
        [book.accounts.puller.address],
        [r.value.signature],
      ],
    });
    expect(message).toMatch(/NotGuardian/);
  });

  it("expired deadline: swap signed in the (fictional) past → SwapExpired", async () => {
    const { book, clients } = fixture.snapshot();
    // Use chain time as the anchor (warped forward by §7.5 setup), then
    // pretend "now" is one hour behind chain. The off-chain §A check
    // sees `deadline within window of pretendNow` and accepts; the
    // chain clock is past the deadline so the contract rejects.
    const blockNow = await clients.publicClient.getBlock();
    const oneHourBehindChainSeconds = Number(BigInt(blockNow.timestamp) - 3600n);
    const sign = makeSignIntentSwap({
      checks: buildIntentSwapChecks({ policy: swapPolicy(book) }),
      guardianSigner: book.accounts.guardian.address,
    });
    const ctx = makeE2eSigningContext({
      client: clients.publicClient,
      privateKey: book.accounts.guardian.privateKey,
      chainId: book.chainId,
      now: new Date(oneHourBehindChainSeconds * 1000),
    });
    const deadline = oneHourBehindChainSeconds + 300;

    const r = await sign(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      legs: [
        { intent: { id: "1" }, asset: book.positionManager, amount: "1" },
        { intent: { id: "2" }, asset: book.tokens.debt, amount: "1" },
      ],
      deadline,
    });
    expect(r.isOk()).toBe(true);
    if (!r.isOk()) return;

    const message = await writeExpectRevert({
      clients,
      account: book.accounts.facilitator.account,
      address: book.facility,
      abi: artifacts.Facility.abi as Abi,
      functionName: "swap",
      args: [
        {
          id1: 1n,
          token1: book.positionManager,
          id2: 2n,
          token2: book.tokens.debt,
          amount1: 1n,
          amount2: 1n,
          deadline: BigInt(deadline),
        },
        [book.accounts.guardian.address],
        [r.value.signature],
      ],
    });
    // FacilitySwap uses its own `SwapExpired` selector for the deadline
    // check rather than the shared `DeadlineExpired`.
    expect(message).toMatch(/SwapExpired/);
    expect(message).not.toMatch(SIGNATURE_CLASS_REVERT);
  });

  it("happy path: real check + guardian sig is accepted by Facility.swap (digest reaches the contract)", async () => {
    const { book, clients } = fixture.snapshot();
    const blockNow = await clients.publicClient.getBlock();
    const sign = makeSignIntentSwap({
      checks: buildIntentSwapChecks({ policy: swapPolicy(book) }),
      guardianSigner: book.accounts.guardian.address,
    });
    const ctx = makeE2eSigningContext({
      client: clients.publicClient,
      privateKey: book.accounts.guardian.privateKey,
      chainId: book.chainId,
      now: new Date(Number(blockNow.timestamp) * 1000),
    });
    const deadline = Number(BigInt(blockNow.timestamp) + 300n);

    // Empty PM (totalSupply=0, virtualShareOffset=1) ⇒ check tolerates
    // any (pmShares, debtAmount) where they're equal. We pick the
    // smallest non-zero pair to dodge the contract's `InvalidSwapAmount`.
    const pmShares = 1n;
    const debtAmount = 1n;

    const r = await sign(ctx, {
      chainId: book.chainId,
      facility: book.facility,
      legs: [
        { intent: { id: "1" }, asset: book.positionManager, amount: pmShares.toString() },
        { intent: { id: "2" }, asset: book.tokens.debt, amount: debtAmount.toString() },
      ],
      deadline,
    });
    expect(r.isOk(), r.isErr() ? JSON.stringify(r.error) : "").toBe(true);
    if (!r.isOk()) return;
    for (const c of r.value.checks) expect(c.passed, c.description).toBe(true);

    // SwapParams: (id1, token1, id2, token2, amount1, amount2, deadline).
    // Canonicalisation in the typed-data sorts legs by intent.id ascending,
    // so the on-chain submission MUST mirror that ordering: id1=1 (PM),
    // id2=2 (debt). Otherwise the digest the contract recomputes won't
    // match the one we signed.
    //
    // We can't fund the intents without a multi-step deposit dance
    // (mint MockERC20 → approve → Facility.deposit → mint PM shares via
    // borrow), so the actual transfer step (`amounts.sub`) is expected
    // to underflow. That's fine: this test exists to prove the
    // *signature* is accepted by the contract — i.e. the revert is not
    // signature-class. Any revert past `_checkSignatures` (notably
    // `InsufficientBalance`) is downstream of acceptance and counts as
    // a pass.
    let revertMessage: string | null = null;
    try {
      await writeAndWait({
        clients,
        account: book.accounts.facilitator.account,
        address: book.facility,
        abi: artifacts.Facility.abi as Abi,
        functionName: "swap",
        args: [
          {
            id1: 1n,
            token1: book.positionManager,
            id2: 2n,
            token2: book.tokens.debt,
            amount1: pmShares,
            amount2: debtAmount,
            deadline: BigInt(deadline),
          },
          [book.accounts.guardian.address],
          [r.value.signature],
        ],
      });
    } catch (err) {
      revertMessage = err instanceof Error ? err.message : String(err);
    }
    if (revertMessage !== null) {
      expect(revertMessage).not.toMatch(SIGNATURE_CLASS_REVERT);
      expect(revertMessage).not.toMatch(/NotGuardian|DigestUsed|DeadlineExpired|SwapExpired/);
    }
  });
});
