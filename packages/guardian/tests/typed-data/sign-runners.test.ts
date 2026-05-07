import { describe, expect, it } from "vitest";
import { Result } from "better-result";
import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { privateKeyToSignTypedData } from "../../src/signers/private-key.js";
import { noopLogger } from "../../src/lib/logger.js";
import { ValidationFailedError } from "../../src/errors/tagged.js";
import {
  makeSignIntentFundBinding,
  makeSignIntentRequestBinding,
  makeSignIntentSwap,
  makeSignRequestWhitelisting,
} from "../../src/typed-data/sign-runners.js";
import type { SigningContext } from "../../src/abstractions.js";
import type { CheckEntry } from "../../src/schemas/checks.js";

const PK = ("0x" + "11".repeat(32)) as Hex;
const account = privateKeyToAccount(PK);
const SIGNER = account.address;
const FACILITY = "0x1111111111111111111111111111111111111111" as Address;
const BOOK = "0x2222222222222222222222222222222222222222" as Address;

const passing: CheckEntry[] = [{ description: "ok", passed: true, skipped: false }];

function clientReturning(payload: readonly unknown[]): PublicClient {
  return {
    readContract: async () => payload,
  } as unknown as PublicClient;
}

function ctxFor(client: PublicClient): SigningContext {
  return {
    chainId: 1,
    client,
    requestId: "00000000-0000-4000-8000-000000000000",
    tokenId: "tk",
    now: new Date(1_700_000_000_000),
    signTypedData: privateKeyToSignTypedData(PK),
    logger: noopLogger,
  };
}

const facilityDomainPayload = ["0x0f", "3F", "1", 1n, FACILITY, "0x" + "0".repeat(64), []] as const;
const bookDomainPayload = [
  "0x0f",
  "3fRequestWhitelist",
  "1",
  1n,
  BOOK,
  "0x" + "0".repeat(64),
  [],
] as const;

describe("makeSignIntentRequestBinding", () => {
  it("propagates a check failure verbatim and skips the signer", async () => {
    const sign = makeSignIntentRequestBinding({
      checks: async () =>
        Result.err(
          new ValidationFailedError({
            message: "nope",
            checks: [{ description: "x", passed: false, skipped: false, reason: "no" }],
          }),
        ),
      guardianSigner: SIGNER,
    });
    const r = await sign(ctxFor(clientReturning(facilityDomainPayload)), {
      chainId: 1,
      facility: FACILITY,
      intent: { id: "1" },
      requestContract: ("0x" + "33".repeat(20)) as Address,
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error._tag).toBe("ValidationFailed");
  });

  it("returns SigningSuccess with payloadHash and a signature recoverable to the signer", async () => {
    const client = clientReturning(facilityDomainPayload);
    const sign = makeSignIntentRequestBinding({
      checks: async () => Result.ok(passing),
      guardianSigner: SIGNER,
    });
    const r = await sign(ctxFor(client), {
      chainId: 1,
      facility: FACILITY,
      intent: { id: "1" },
      requestContract: ("0x" + "33".repeat(20)) as Address,
      deadline: 1_700_000_500,
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.guardian).toBe(SIGNER);
      expect(r.value.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.value.checks).toEqual(passing);
      // round-trip: recover the signer from the digest + sig
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: "3F",
          version: "1",
          chainId: 1,
          verifyingContract: FACILITY,
        },
        types: {
          SetRequestParams: [
            { name: "id", type: "uint256" },
            { name: "newRequest", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "SetRequestParams",
        message: {
          id: 1n,
          newRequest: ("0x" + "33".repeat(20)) as Address,
          deadline: 1_700_000_500n,
        },
        signature: r.value.signature,
      });
      expect(recovered.toLowerCase()).toBe(SIGNER.toLowerCase());
    }
  });
});

describe("makeSignIntentFundBinding", () => {
  it("signs a fund-binding payload that excludes positionManager from the digest", async () => {
    const client = clientReturning(facilityDomainPayload);
    const sign = makeSignIntentFundBinding({
      checks: async () => Result.ok(passing),
      guardianSigner: SIGNER,
    });
    const a = await sign(ctxFor(client), {
      chainId: 1,
      facility: FACILITY,
      intent: { id: "9" },
      fundContract: ("0x" + "44".repeat(20)) as Address,
      positionManager: ("0x" + "0a".repeat(20)) as Address,
      deadline: 1_700_000_500,
    });
    const b = await sign(ctxFor(client), {
      chainId: 1,
      facility: FACILITY,
      intent: { id: "9" },
      fundContract: ("0x" + "44".repeat(20)) as Address,
      positionManager: ("0x" + "0b".repeat(20)) as Address,
      deadline: 1_700_000_500,
    });
    expect(a.isOk() && b.isOk()).toBe(true);
    if (a.isOk() && b.isOk()) expect(a.value.payloadHash).toBe(b.value.payloadHash);
  });
});

describe("makeSignIntentSwap", () => {
  it("[A,B] and [B,A] yield identical signature + payloadHash", async () => {
    const client = clientReturning(facilityDomainPayload);
    const sign = makeSignIntentSwap({
      checks: async () => Result.ok(passing),
      guardianSigner: SIGNER,
    });
    const ab = await sign(ctxFor(client), {
      chainId: 1,
      facility: FACILITY,
      legs: [
        {
          intent: { id: "1" },
          asset: ("0x" + "aa".repeat(20)) as Address,
          amount: "100",
        },
        {
          intent: { id: "2" },
          asset: ("0x" + "bb".repeat(20)) as Address,
          amount: "200",
        },
      ],
      deadline: 1_700_000_500,
    });
    const ba = await sign(ctxFor(client), {
      chainId: 1,
      facility: FACILITY,
      legs: [
        {
          intent: { id: "2" },
          asset: ("0x" + "bb".repeat(20)) as Address,
          amount: "200",
        },
        {
          intent: { id: "1" },
          asset: ("0x" + "aa".repeat(20)) as Address,
          amount: "100",
        },
      ],
      deadline: 1_700_000_500,
    });
    expect(ab.isOk() && ba.isOk()).toBe(true);
    if (ab.isOk() && ba.isOk()) {
      expect(ab.value.payloadHash).toBe(ba.value.payloadHash);
      expect(ab.value.signature).toBe(ba.value.signature);
    }
  });
});

describe("makeSignRequestWhitelisting", () => {
  it("§7.6.1 response carries address (== guardianSigner) and verbatim nonce", async () => {
    const client = clientReturning(bookDomainPayload);
    const sign = makeSignRequestWhitelisting({
      checks: async () => Result.ok(passing),
      guardianSigner: SIGNER,
    });
    const r = await sign(ctxFor(client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [("0x" + "55".repeat(20)) as Address],
      nonce: "7",
      deadline: 1_700_000_500,
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.address).toBe(SIGNER);
      expect(r.value.nonce).toBe("7");
      expect(r.value.guardian).toBe(SIGNER);
      // `payloadHash` reproduces from the same typed-data shape:
      const expected = hashTypedData({
        domain: {
          name: "3fRequestWhitelist",
          version: "1",
          chainId: 1,
          verifyingContract: BOOK,
        },
        types: {
          WhitelistRequest: [
            { name: "targets", type: "address[]" },
            { name: "deadline", type: "uint256" },
            { name: "validator", type: "address" },
            { name: "nonce", type: "uint256" },
          ],
        },
        primaryType: "WhitelistRequest",
        message: {
          targets: [("0x" + "55".repeat(20)) as Address],
          deadline: 1_700_000_500n,
          validator: SIGNER,
          nonce: 7n,
        },
      });
      expect(r.value.payloadHash).toBe(expected);
    }
  });

  it("uses Unwhitelist primaryType when operation == 'unwhitelist'", async () => {
    const client = clientReturning(bookDomainPayload);
    const sign = makeSignRequestWhitelisting({
      checks: async () => Result.ok(passing),
      guardianSigner: SIGNER,
    });
    const w = await sign(ctxFor(client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [("0x" + "55".repeat(20)) as Address],
      nonce: "7",
      deadline: 1_700_000_500,
    });
    const u = await sign(ctxFor(client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [("0x" + "55".repeat(20)) as Address],
      nonce: "7",
      deadline: 1_700_000_500,
    });
    expect(w.isOk() && u.isOk()).toBe(true);
    if (w.isOk() && u.isOk()) expect(w.value.payloadHash).not.toBe(u.value.payloadHash);
  });
});
