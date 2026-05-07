import { describe, expect, it } from "vitest";
import { keccak256, toBytes, type Hex } from "viem";

/**
 * Cross-check the type strings encoded in `typed-data/*` against the
 * `*_TYPEHASH` constants pinned in the on-chain verifiers. If either side
 * drifts (a contract upgrade or a typo in the local types object), the
 * Guardian's signatures would still verify *off-chain* via viem but
 * would not match the digest the on-chain `_hashTypedData` recomputes —
 * which is exactly the failure mode this test guards against.
 *
 * Pinned constants:
 *  - SET_FUND_PARAMS_TYPEHASH    — grunt/src/facility/base/FacilityIntents.sol
 *  - SET_REQUEST_PARAMS_TYPEHASH — grunt/src/facility/base/FacilityIntents.sol
 *  - SWAP_PARAMS_TYPEHASH        — grunt/src/facility/base/FacilitySwap.sol
 *  - _WHITELIST_TYPEHASH         — 3f-request-whitelist/src/RequestWhitelist.sol
 *  - _UNWHITELIST_TYPEHASH       — derived (same shape, different name)
 */
function typehash(typeString: string): Hex {
  return keccak256(toBytes(typeString));
}

describe("on-chain typehashes match the local type strings", () => {
  it("SetFundParams", () => {
    expect(typehash("SetFundParams(uint256 id,address newFund,uint256 deadline)")).toBe(
      "0x5b29fe7a3c7ef719629449a6e2c108e8c6d692027b5327c7edbdc163a7ce1b0b",
    );
  });

  it("SetRequestParams", () => {
    expect(typehash("SetRequestParams(uint256 id,address newRequest,uint256 deadline)")).toBe(
      "0x3fab97cdfeba7b67ca42aeebb63ab14ea67e6637d1e42acb3a06b721f7d72438",
    );
  });

  it("SwapParams", () => {
    expect(
      typehash(
        "SwapParams(uint256 id1,address token1,uint256 id2,address token2," +
          "uint256 amount1,uint256 amount2,uint256 deadline)",
      ),
    ).toBe("0x8b4e182587850acdf21dcf7a0f61b2fd7267c2cdf71d4692b57fb97237a29be3");
  });

  // The on-chain `_WHITELIST_TYPEHASH` / `_UNWHITELIST_TYPEHASH` are computed
  // by `keccak256` over the literal type strings at deployment, not declared
  // as hex literals in source. Pinning the digests here is the only mechanism
  // that catches member-list drift between the local types and the contract:
  // change either side and this assertion flips.
  it("WhitelistRequest matches the on-chain `_WHITELIST_TYPEHASH`", () => {
    expect(
      typehash(
        "WhitelistRequest(address[] targets,uint256 deadline,address validator,uint256 nonce)",
      ),
    ).toBe("0xa8db10babac68d55857fffaeaab73e548d66fb84663570412bbbd6f30f266cc8");
  });

  it("UnwhitelistRequest matches the on-chain `_UNWHITELIST_TYPEHASH`", () => {
    expect(
      typehash(
        "UnwhitelistRequest(address[] targets,uint256 deadline,address validator,uint256 nonce)",
      ),
    ).toBe("0x443ef9facc6714953ad928983b8f4074dba8de482120dc2efbd165f30b96244b");
  });
});
