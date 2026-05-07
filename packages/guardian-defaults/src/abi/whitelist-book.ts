/**
 * Minimal viem ABI for `RequestWhitelist` (3F protocol).
 *
 * Per-validator nonce state — every Guardian-shaped validator has its
 * own nonce floor and consumed-bitmap. The §A.4 runner reads both with
 * `guardianSigner` as the validator key.
 *
 *  - `validatorNonceFloor(v)` — the monotonic floor; on-chain
 *    `QuorumSigLib.assertSigValid` rejects signatures with
 *    `nonce < floor` (strictly less-than), so `nonce == floor` is the
 *    one usable nonce at the floor itself. The runner mirrors this:
 *    `nonce >= floor` passes.
 *  - `isNonceConsumed(v, n)` — true iff bit `n` of `v`'s bitmap is set.
 *    Independent of the floor (a nonce below the floor returns `false`
 *    here even though it would be unusable).
 *
 * Mirrors `3f-request-whitelist/src/RequestWhitelist.sol`.
 */
export const whitelistBookAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "validatorNonceFloor",
    inputs: [{ name: "v", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "isNonceConsumed",
    inputs: [
      { name: "v", type: "address" },
      { name: "n", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
