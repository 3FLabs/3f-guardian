import { hashTypedData, type TypedDataDefinition } from "viem";

import type { IntentSwapBody, SwapLeg } from "../schemas/intent-swap.js";
import type { Eip712Domain, GuardianTypedData } from "./types.js";

/**
 * §A.3 / §7.5 — the facility's `swap` typed-data struct.
 *
 * Mirrors `SWAP_PARAMS_TYPEHASH` in
 * `grunt/src/facility/base/FacilitySwap.sol`:
 *
 *   keccak256(
 *     "SwapParams(uint256 id1,address token1,uint256 id2,address token2,"
 *     "uint256 amount1,uint256 amount2,uint256 deadline)"
 *   )
 *
 * The contract hashes `keccak256(abi.encode(TYPEHASH, params))` directly
 * over the calldata struct — no nested `address[]` or `bytes` — so viem's
 * default `hashTypedData` produces the matching digest.
 */
export const swapParamsTypes = {
  SwapParams: [
    { name: "id1", type: "uint256" },
    { name: "token1", type: "address" },
    { name: "id2", type: "uint256" },
    { name: "token2", type: "address" },
    { name: "amount1", type: "uint256" },
    { name: "amount2", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

type SwapParamsTypedData = TypedDataDefinition<typeof swapParamsTypes, "SwapParams">;

/**
 * Per §7.5 the legs array is unordered: implementations MUST normalise
 * legs before signing so `[A, B]` and `[B, A]` produce byte-identical
 * `signature` and `payloadHash`.
 *
 * Canonical order: ascending numeric `intent.id`, ties broken by
 * ascending lower-cased `asset` address. Stable for any two distinct
 * legs (intent ids may repeat in principle, but the `asset` tie-break
 * always disambiguates the two legs in a swap because §A.3 rejects
 * same-asset swaps on the contract side).
 *
 * Throws on a `legs.length !== 2` input — the caller is responsible
 * for upstream validation (the §7.5 zod schema enforces it). The throw
 * is defensive.
 */
export function canonicaliseSwapLegs(legs: readonly SwapLeg[]): readonly [SwapLeg, SwapLeg] {
  const [a, b, extra] = legs;
  if (!a || !b || extra) {
    throw new Error("canonicaliseSwapLegs requires exactly two legs");
  }
  const idA = BigInt(a.intent.id);
  const idB = BigInt(b.intent.id);
  if (idA < idB) return [a, b];
  if (idA > idB) return [b, a];
  return a.asset.toLowerCase() <= b.asset.toLowerCase() ? [a, b] : [b, a];
}

/**
 * Builds the EIP-712 typed-data payload for §7.5 `intent-swaps`.
 *
 * The legs are canonicalised first; the resulting (id1, token1) pair
 * is the leg with the lower intent id (or asset, on tie), so the
 * signature is stable regardless of caller-side ordering.
 */
export function buildIntentSwapTypedData(args: {
  domain: Eip712Domain;
  body: IntentSwapBody;
}): GuardianTypedData<typeof swapParamsTypes, "SwapParams"> {
  const { domain, body } = args;
  const [first, second] = canonicaliseSwapLegs(body.legs);
  const typedData: SwapParamsTypedData = {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: swapParamsTypes,
    primaryType: "SwapParams",
    message: {
      id1: BigInt(first.intent.id),
      token1: first.asset,
      id2: BigInt(second.intent.id),
      token2: second.asset,
      amount1: BigInt(first.amount),
      amount2: BigInt(second.amount),
      deadline: BigInt(body.deadline),
    },
  };
  return { typedData, payloadHash: hashTypedData(typedData) };
}
