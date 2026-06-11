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
 * Canonical order, applied as a strict comparator chain:
 *
 *   1. ascending numeric `intent.id`
 *   2. ascending lower-cased `asset` address
 *   3. ascending numeric `amount`
 *
 * If all three keys tie the legs are byte-identical, so the order is
 * irrelevant and we return `[a, b]`. §A.3 rejects same-asset swaps on
 * the contract side so the (id, asset) tie-break disambiguates in
 * practice; the `amount` rung guards against a bypass where two legs
 * share id+asset but differ only by `amount` (whose value lands in
 * the signed payload as `amount1` / `amount2`).
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
  const assetA = a.asset.toLowerCase();
  const assetB = b.asset.toLowerCase();
  if (assetA < assetB) return [a, b];
  if (assetA > assetB) return [b, a];
  const amountA = BigInt(a.amount);
  const amountB = BigInt(b.amount);
  if (amountA < amountB) return [a, b];
  if (amountA > amountB) return [b, a];
  return [a, b];
}

/**
 * Builds the EIP-712 typed-data payload for §7.5 `intent-swaps`.
 *
 * `domain.verifyingContract` MUST equal `body.facility`; a mismatch
 * throws — signing under the wrong verifier yields a digest the
 * on-chain `swap` could never accept.
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
  if (domain.verifyingContract.toLowerCase() !== body.facility.toLowerCase()) {
    throw new Error("buildIntentSwapTypedData: domain.verifyingContract must equal body.facility");
  }
  const [first, second] = canonicaliseSwapLegs(body.legs);
  const typedData: SwapParamsTypedData = {
    domain,
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
