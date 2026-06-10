import { describe, expect, it } from "vitest";
import { getAddress, hashTypedData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  buildIntentFundBindingTypedData,
  buildIntentRequestBindingTypedData,
  buildIntentSwapTypedData,
  buildRequestWhitelistingTypedData,
  buildUnwhitelistRequestTypedData,
  buildWhitelistRequestTypedData,
  canonicaliseSwapLegs,
  type Eip712Domain,
} from "../../src/typed-data/index.js";

const PK = ("0x" + "11".repeat(32)) as Hex;
const account = privateKeyToAccount(PK);
const FACILITY = "0x1111111111111111111111111111111111111111" as Address;
const BOOK = "0x2222222222222222222222222222222222222222" as Address;
const REQUEST = "0x3333333333333333333333333333333333333333" as Address;
const FUND = "0x4444444444444444444444444444444444444444" as Address;
const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const RC1 = "0x5555555555555555555555555555555555555555" as Address;
const RC2 = "0x6666666666666666666666666666666666666666" as Address;

const FACILITY_DOMAIN: Eip712Domain = {
  name: "3F",
  version: "1",
  chainId: 1,
  verifyingContract: FACILITY,
};

const BOOK_DOMAIN: Eip712Domain = {
  name: "3fRequestWhitelist",
  version: "1",
  chainId: 1,
  verifyingContract: BOOK,
};

describe("buildIntentRequestBindingTypedData", () => {
  it("payloadHash equals hashTypedData(typedData)", () => {
    const { typedData, payloadHash } = buildIntentRequestBindingTypedData({
      domain: FACILITY_DOMAIN,
      body: {
        chainId: 1,
        facility: FACILITY,
        intent: { id: "42" },
        requestContract: REQUEST,
        deadline: 1_700_000_600,
      },
    });
    expect(payloadHash).toBe(hashTypedData(typedData));
  });

  it("signs and recovers to the signer", async () => {
    const { typedData } = buildIntentRequestBindingTypedData({
      domain: FACILITY_DOMAIN,
      body: {
        chainId: 1,
        facility: FACILITY,
        intent: { id: "42" },
        requestContract: REQUEST,
        deadline: 1_700_000_600,
      },
    });
    const signature = await account.signTypedData(typedData);
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});

describe("buildIntentFundBindingTypedData", () => {
  it("payloadHash equals hashTypedData(typedData)", () => {
    const { typedData, payloadHash } = buildIntentFundBindingTypedData({
      domain: FACILITY_DOMAIN,
      body: {
        chainId: 1,
        facility: FACILITY,
        intent: { id: "7" },
        fundContract: FUND,
        positionManager: ("0x" + "0a".repeat(20)) as Address,
        deadline: 1_700_000_600,
      },
    });
    expect(payloadHash).toBe(hashTypedData(typedData));
  });

  it("does NOT include positionManager in the signed payload", () => {
    const baseBody = {
      chainId: 1 as const,
      facility: FACILITY,
      intent: { id: "7" },
      fundContract: FUND,
      deadline: 1_700_000_600,
    };
    const a = buildIntentFundBindingTypedData({
      domain: FACILITY_DOMAIN,
      body: { ...baseBody, positionManager: ("0x" + "0a".repeat(20)) as Address },
    }).payloadHash;
    const b = buildIntentFundBindingTypedData({
      domain: FACILITY_DOMAIN,
      body: { ...baseBody, positionManager: ("0x" + "0b".repeat(20)) as Address },
    }).payloadHash;
    expect(a).toBe(b);
  });
});

describe("buildIntentSwapTypedData", () => {
  const baseBody = {
    chainId: 1 as const,
    facility: FACILITY,
    deadline: 1_700_000_600,
  };

  it("[A, B] and [B, A] produce identical payloadHash (canonicalisation)", () => {
    const ab = buildIntentSwapTypedData({
      domain: FACILITY_DOMAIN,
      body: {
        ...baseBody,
        legs: [
          { intent: { id: "1" }, asset: TOKEN_A, amount: "100" },
          { intent: { id: "2" }, asset: TOKEN_B, amount: "200" },
        ],
      },
    });
    const ba = buildIntentSwapTypedData({
      domain: FACILITY_DOMAIN,
      body: {
        ...baseBody,
        legs: [
          { intent: { id: "2" }, asset: TOKEN_B, amount: "200" },
          { intent: { id: "1" }, asset: TOKEN_A, amount: "100" },
        ],
      },
    });
    expect(ab.payloadHash).toBe(ba.payloadHash);
  });

  it("canonicaliseSwapLegs sorts by intent.id ascending", () => {
    const [first, second] = canonicaliseSwapLegs([
      { intent: { id: "9" }, asset: TOKEN_A, amount: "1" },
      { intent: { id: "3" }, asset: TOKEN_B, amount: "2" },
    ]);
    expect(first.intent.id).toBe("3");
    expect(second.intent.id).toBe("9");
  });

  it("canonicaliseSwapLegs tie-breaks by asset address (lower-cased) ascending", () => {
    const result = canonicaliseSwapLegs([
      { intent: { id: "1" }, asset: TOKEN_B, amount: "1" },
      { intent: { id: "1" }, asset: TOKEN_A, amount: "2" },
    ]);
    expect(result[0].asset).toBe(TOKEN_A);
  });

  it("canonicaliseSwapLegs returns input order when all comparator keys tie (id+asset+amount)", () => {
    // Edge case: every rung of the comparator chain (id → asset → amount)
    // ties, so the function falls through to the `[a, b]` return. The two
    // legs are byte-identical, so order doesn't matter for the digest —
    // we just want to prove the function doesn't loop or throw on a tie.
    const a = { intent: { id: "1" }, asset: TOKEN_A, amount: "100" };
    const b = { intent: { id: "1" }, asset: TOKEN_A, amount: "100" };
    const [first, second] = canonicaliseSwapLegs([a, b]);
    expect(first).toBe(a);
    expect(second).toBe(b);
  });

  it("canonicaliseSwapLegs tie-breaks by amount when id+asset tie", () => {
    // Same id, same asset, different amount — the third comparator rung
    // disambiguates so the leg with the smaller amount lands first.
    const big = { intent: { id: "1" }, asset: TOKEN_A, amount: "200" };
    const small = { intent: { id: "1" }, asset: TOKEN_A, amount: "100" };
    const [first, second] = canonicaliseSwapLegs([big, small]);
    expect(first).toBe(small);
    expect(second).toBe(big);
  });

  it("canonicaliseSwapLegs throws when given fewer or more than two legs", () => {
    expect(() => canonicaliseSwapLegs([])).toThrow();
    expect(() =>
      canonicaliseSwapLegs([{ intent: { id: "1" }, asset: TOKEN_A, amount: "1" }]),
    ).toThrow();
    expect(() =>
      canonicaliseSwapLegs([
        { intent: { id: "1" }, asset: TOKEN_A, amount: "1" },
        { intent: { id: "2" }, asset: TOKEN_B, amount: "2" },
        { intent: { id: "3" }, asset: TOKEN_A, amount: "3" },
      ]),
    ).toThrow();
  });

  it("signs and recovers to the signer", async () => {
    const { typedData } = buildIntentSwapTypedData({
      domain: FACILITY_DOMAIN,
      body: {
        ...baseBody,
        legs: [
          { intent: { id: "1" }, asset: TOKEN_A, amount: "100" },
          { intent: { id: "2" }, asset: TOKEN_B, amount: "200" },
        ],
      },
    });
    const signature = await account.signTypedData(typedData);
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("throws when domain.verifyingContract does not equal body.facility", () => {
    // Same fail-closed guard as the binding builders: a domain resolved for
    // one contract must never sign a body referencing another.
    expect(() =>
      buildIntentSwapTypedData({
        domain: { ...FACILITY_DOMAIN, verifyingContract: BOOK },
        body: {
          ...baseBody,
          legs: [
            { intent: { id: "1" }, asset: TOKEN_A, amount: "100" },
            { intent: { id: "2" }, asset: TOKEN_B, amount: "200" },
          ],
        },
      }),
    ).toThrow("buildIntentSwapTypedData: domain.verifyingContract must equal body.facility");
  });

  it("accepts a case-insensitive facility match", () => {
    const checksummed = getAddress(TOKEN_A); // mixed-case EIP-55 form of the lower-case address
    expect(() =>
      buildIntentSwapTypedData({
        domain: { ...FACILITY_DOMAIN, verifyingContract: checksummed },
        body: {
          ...baseBody,
          facility: TOKEN_A,
          legs: [
            { intent: { id: "1" }, asset: TOKEN_A, amount: "100" },
            { intent: { id: "2" }, asset: TOKEN_B, amount: "200" },
          ],
        },
      }),
    ).not.toThrow();
  });
});

describe("buildRequestWhitelistingTypedData", () => {
  const baseBody = {
    chainId: 1 as const,
    whitelistBook: BOOK,
    requestContracts: [RC1, RC2],
    nonce: "5",
    deadline: 1_700_000_600,
  };

  it("whitelist op uses primaryType WhitelistRequest", () => {
    const { typedData } = buildRequestWhitelistingTypedData({
      domain: BOOK_DOMAIN,
      validator: account.address,
      body: { ...baseBody, operation: "whitelist" },
    });
    expect(typedData.primaryType).toBe("WhitelistRequest");
  });

  it("unwhitelist op uses primaryType UnwhitelistRequest", () => {
    const { typedData } = buildRequestWhitelistingTypedData({
      domain: BOOK_DOMAIN,
      validator: account.address,
      body: { ...baseBody, operation: "unwhitelist" },
    });
    expect(typedData.primaryType).toBe("UnwhitelistRequest");
  });

  it("whitelist and unwhitelist produce different payloadHash for identical fields", () => {
    const w = buildRequestWhitelistingTypedData({
      domain: BOOK_DOMAIN,
      validator: account.address,
      body: { ...baseBody, operation: "whitelist" },
    }).payloadHash;
    const u = buildRequestWhitelistingTypedData({
      domain: BOOK_DOMAIN,
      validator: account.address,
      body: { ...baseBody, operation: "unwhitelist" },
    }).payloadHash;
    expect(w).not.toBe(u);
  });

  it("signs and recovers to the validator (== signer in v1)", async () => {
    // Use the typed (non-union) builder so `signTypedData` / `recoverTypedDataAddress`
    // can infer a concrete generic.
    const { ...rest } = { ...baseBody, operation: "whitelist" as const };
    const { typedData } = buildWhitelistRequestTypedData({
      domain: BOOK_DOMAIN,
      validator: account.address,
      body: rest,
    });
    const signature = await account.signTypedData(typedData);
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("buildUnwhitelistRequestTypedData mirrors the whitelist shape with a different primaryType", () => {
    const { ...rest } = { ...baseBody, operation: "unwhitelist" as const };
    const { typedData } = buildUnwhitelistRequestTypedData({
      domain: BOOK_DOMAIN,
      validator: account.address,
      body: rest,
    });
    expect(typedData.primaryType).toBe("UnwhitelistRequest");
  });

  it("whitelist builder throws when domain.verifyingContract does not equal body.whitelistBook", () => {
    expect(() =>
      buildWhitelistRequestTypedData({
        domain: { ...BOOK_DOMAIN, verifyingContract: FACILITY },
        validator: account.address,
        body: baseBody,
      }),
    ).toThrow(
      "buildWhitelistRequestTypedData: domain.verifyingContract must equal body.whitelistBook",
    );
  });

  it("unwhitelist builder throws when domain.verifyingContract does not equal body.whitelistBook", () => {
    expect(() =>
      buildUnwhitelistRequestTypedData({
        domain: { ...BOOK_DOMAIN, verifyingContract: FACILITY },
        validator: account.address,
        body: baseBody,
      }),
    ).toThrow(
      "buildUnwhitelistRequestTypedData: domain.verifyingContract must equal body.whitelistBook",
    );
  });

  it("union builder inherits the verifyingContract guard via the per-operation builders", () => {
    expect(() =>
      buildRequestWhitelistingTypedData({
        domain: { ...BOOK_DOMAIN, verifyingContract: FACILITY },
        validator: account.address,
        body: { ...baseBody, operation: "whitelist" },
      }),
    ).toThrow("domain.verifyingContract must equal body.whitelistBook");
  });
});

// `buildRequestWhitelistingTypedData` (the union form) is exercised via the
// `primaryType` and `payloadHash` assertions above; the value-level switch is
// trivially correct so we don't separately re-prove it here.
void buildRequestWhitelistingTypedData;
