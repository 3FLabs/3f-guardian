/**
 * On-chain proof that the four `makeSign*` orchestrators produce
 * signatures the verifying contracts would accept.
 *
 * Strategy:
 *  1. Wire each orchestrator with a trivial check runner that always
 *     succeeds (the §A integration tests in `@3flabs/guardian-defaults`
 *     prove the real check runners work against the deployed stack).
 *  2. Have the orchestrator fetch the EIP-712 domain from the real
 *     contract, build typed-data, and sign via
 *     `privateKeyToSignTypedData(GUARDIAN_PK)`.
 *  3. Two acceptance checks per signing flow:
 *      - Local: `recoverTypedDataAddress` returns the guardian. If the
 *        contract uses the same domain + typehash (we read both from
 *        the contract), it would accept this signature too.
 *      - On-chain (where viable): submit the signature to the verifying
 *        view (e.g. `Facility.setRequest`). We don't require success —
 *        many of those calls fail on *non-signature* preconditions
 *        (asset match, intent state, …); we only assert the call does
 *        NOT revert with `NotGuardian` or `BadSignature`.
 */

import { Result } from "better-result";
import { beforeAll, describe, expect, it } from "vitest";
import { type Address, encodeFunctionData, type Hex, recoverTypedDataAddress } from "viem";
import type { CheckEntry, SigningContext } from "../../src/index.js";

import {
  buildIntentRequestBindingTypedData,
  buildIntentSwapTypedData,
  buildIntentFundBindingTypedData,
  buildWhitelistRequestTypedData,
  buildUnwhitelistRequestTypedData,
} from "../../src/typed-data/index.js";
import {
  makeSignIntentFundBinding,
  makeSignIntentRequestBinding,
  makeSignIntentSwap,
  makeSignRequestWhitelisting,
} from "../../src/typed-data/sign-runners.js";
import { fetchEip712DomainNameVersion } from "../../src/lib/eip712-domain.js";
import { privateKeyToSignTypedData } from "../../src/signers/private-key.js";
import { noopLogger } from "../../src/index.js";
import { artifacts, createIntegrationFixture } from "@3flabs/guardian-test-fixtures";

const noopChecks = async <B>(
  _ctx: SigningContext,
  _body: B,
): Promise<Result<readonly CheckEntry[], never>> => Result.ok([]);

function makeCtx(args: {
  client: SigningContext["client"];
  guardianPk: Hex;
  chainId: number;
}): SigningContext {
  return {
    chainId: args.chainId,
    client: args.client,
    requestId: "test",
    tokenId: "test",
    now: new Date(),
    signTypedData: privateKeyToSignTypedData(args.guardianPk),
    logger: noopLogger,
  };
}

describe("makeSign* orchestrators — on-chain", () => {
  const fixture = createIntegrationFixture();
  beforeAll(fixture.setup);

  it("makeSignIntentRequestBinding signature recovers to the guardian and is accepted by Facility.setRequest from the facilitator", async () => {
    const { book, clients } = fixture.snapshot();
    const guardian = book.accounts.guardian;
    const facilitator = book.accounts.facilitator;

    const sign = makeSignIntentRequestBinding({
      checks: noopChecks,
      guardianSigner: guardian.address,
    });
    const ctx = makeCtx({
      client: clients.publicClient,
      guardianPk: guardian.privateKey,
      chainId: book.chainId,
    });
    const blockNow = await clients.publicClient.getBlock();
    const deadline = Number(BigInt(blockNow.timestamp) + 600n);
    const body = {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      requestContract: book.request,
      deadline,
    };
    const r = await sign(ctx, body);
    expect(r.isOk(), r.isErr() ? JSON.stringify(r.error) : "").toBe(true);
    if (!r.isOk()) return;
    const { signature, payloadHash } = r.value;

    // Local recovery — proves the digest the orchestrator built matches
    // the contract's domain (which we read via eip712Domain()).
    const domainRes = await fetchEip712DomainNameVersion({
      client: clients.publicClient,
      chainId: book.chainId,
      verifyingContract: book.facility,
    });
    expect(domainRes.isOk()).toBe(true);
    if (!domainRes.isOk()) return;
    const { typedData, payloadHash: rebuiltHash } = buildIntentRequestBindingTypedData({
      domain: { ...domainRes.value, chainId: book.chainId, verifyingContract: book.facility },
      body,
    });
    expect(rebuiltHash).toBe(payloadHash);
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    expect(recovered.toLowerCase()).toBe(guardian.address.toLowerCase());

    // On-chain: submit via `Facility.setRequest` from the facilitator
    // (FACILITATOR_ROLE granted in deploy). Signature-class reverts in
    // solady carry selectors named `NotGuardian` / `InvalidSignature` /
    // `BadSignature`; we fail the test if we see one and otherwise
    // accept the receipt status.
    const data = encodeFunctionData({
      abi: artifacts.Facility.abi,
      functionName: "setRequest",
      args: [1n, book.request, BigInt(deadline), [guardian.address as Address], [signature]],
    });
    try {
      const hash = await clients.walletClient.sendTransaction({
        account: facilitator.account,
        to: book.facility,
        data,
        chain: clients.walletClient.chain,
      });
      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toMatch(/NotGuardian|InvalidSignature|BadSignature/i);
      throw err;
    }
  });

  it("makeSignIntentFundBinding produces a signature that recovers to the guardian", async () => {
    const { book, clients } = fixture.snapshot();
    const guardian = book.accounts.guardian;
    const sign = makeSignIntentFundBinding({
      checks: noopChecks,
      guardianSigner: guardian.address,
    });
    const ctx = makeCtx({
      client: clients.publicClient,
      guardianPk: guardian.privateKey,
      chainId: book.chainId,
    });
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const body = {
      chainId: book.chainId,
      facility: book.facility,
      intent: { id: "1" },
      fundContract: book.mockFund,
      positionManager: book.positionManager,
      deadline,
    };
    const r = await sign(ctx, body);
    expect(r.isOk(), r.isErr() ? JSON.stringify(r.error) : "").toBe(true);
    if (!r.isOk()) return;
    const domainRes = await fetchEip712DomainNameVersion({
      client: clients.publicClient,
      chainId: book.chainId,
      verifyingContract: book.facility,
    });
    if (!domainRes.isOk()) throw new Error("domain fetch failed");
    const { typedData } = buildIntentFundBindingTypedData({
      domain: { ...domainRes.value, chainId: book.chainId, verifyingContract: book.facility },
      body,
    });
    const recovered = await recoverTypedDataAddress({ ...typedData, signature: r.value.signature });
    expect(recovered.toLowerCase()).toBe(guardian.address.toLowerCase());
  });

  it("makeSignIntentSwap produces a signature that recovers to the guardian and is canonicalisation-stable", async () => {
    const { book, clients } = fixture.snapshot();
    const guardian = book.accounts.guardian;
    const sign = makeSignIntentSwap({
      checks: noopChecks,
      guardianSigner: guardian.address,
    });
    const ctx = makeCtx({
      client: clients.publicClient,
      guardianPk: guardian.privateKey,
      chainId: book.chainId,
    });
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const baseBody = {
      chainId: book.chainId,
      facility: book.facility,
      deadline,
    };
    const ab = await sign(ctx, {
      ...baseBody,
      legs: [
        { intent: { id: "1" }, asset: book.tokens.collateral, amount: "100" },
        { intent: { id: "2" }, asset: book.tokens.debt, amount: "100" },
      ],
    });
    const ba = await sign(ctx, {
      ...baseBody,
      legs: [
        { intent: { id: "2" }, asset: book.tokens.debt, amount: "100" },
        { intent: { id: "1" }, asset: book.tokens.collateral, amount: "100" },
      ],
    });
    expect(ab.isOk() && ba.isOk()).toBe(true);
    if (!ab.isOk() || !ba.isOk()) return;
    expect(ab.value.payloadHash).toBe(ba.value.payloadHash);
    expect(ab.value.signature).toBe(ba.value.signature);

    const domainRes = await fetchEip712DomainNameVersion({
      client: clients.publicClient,
      chainId: book.chainId,
      verifyingContract: book.facility,
    });
    if (!domainRes.isOk()) throw new Error("domain fetch failed");
    const { typedData } = buildIntentSwapTypedData({
      domain: { ...domainRes.value, chainId: book.chainId, verifyingContract: book.facility },
      body: {
        ...baseBody,
        legs: [
          { intent: { id: "1" }, asset: book.tokens.collateral, amount: "100" },
          { intent: { id: "2" }, asset: book.tokens.debt, amount: "100" },
        ],
      },
    });
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature: ab.value.signature,
    });
    expect(recovered.toLowerCase()).toBe(guardian.address.toLowerCase());
  });

  it("makeSignRequestWhitelisting produces signatures that recover to validator1 (whitelist + unwhitelist primary types differ)", async () => {
    const { book, clients } = fixture.snapshot();
    const validator = book.accounts.validator1;
    const sign = makeSignRequestWhitelisting({
      checks: noopChecks,
      guardianSigner: validator.address,
    });
    const ctx = makeCtx({
      client: clients.publicClient,
      guardianPk: validator.privateKey,
      chainId: book.chainId,
    });
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const wl = await sign(ctx, {
      chainId: book.chainId,
      whitelistBook: book.whitelistBook,
      operation: "whitelist",
      requestContracts: [book.request],
      nonce: "0",
      deadline,
    });
    const unwl = await sign(ctx, {
      chainId: book.chainId,
      whitelistBook: book.whitelistBook,
      operation: "unwhitelist",
      requestContracts: [book.request],
      nonce: "0",
      deadline,
    });
    expect(wl.isOk() && unwl.isOk()).toBe(true);
    if (!wl.isOk() || !unwl.isOk()) return;

    const domainRes = await fetchEip712DomainNameVersion({
      client: clients.publicClient,
      chainId: book.chainId,
      verifyingContract: book.whitelistBook,
    });
    if (!domainRes.isOk()) throw new Error("domain fetch failed");
    const domain = {
      ...domainRes.value,
      chainId: book.chainId,
      verifyingContract: book.whitelistBook,
    };
    const wlBuilt = buildWhitelistRequestTypedData({
      domain,
      validator: validator.address,
      body: {
        chainId: book.chainId,
        whitelistBook: book.whitelistBook,
        requestContracts: [book.request],
        nonce: "0",
        deadline,
      },
    });
    const unwlBuilt = buildUnwhitelistRequestTypedData({
      domain,
      validator: validator.address,
      body: {
        chainId: book.chainId,
        whitelistBook: book.whitelistBook,
        requestContracts: [book.request],
        nonce: "0",
        deadline,
      },
    });
    const wlRec = await recoverTypedDataAddress({
      ...wlBuilt.typedData,
      signature: wl.value.signature,
    });
    const unwlRec = await recoverTypedDataAddress({
      ...unwlBuilt.typedData,
      signature: unwl.value.signature,
    });
    expect(wlRec.toLowerCase()).toBe(validator.address.toLowerCase());
    expect(unwlRec.toLowerCase()).toBe(validator.address.toLowerCase());

    // The two signatures MUST differ since the primary types differ.
    expect(wl.value.signature).not.toBe(unwl.value.signature);
  });
});
