/**
 * Minimal viem ABI for `Request` (3F protocol). Only the surface needed
 * by Appendix-A check builders is included.
 *
 * `Request` inherits `OwnableRoles` (solady) — `owner` and `hasAllRoles`
 * come from there. Solady emits a single role-mutation event,
 * `RolesUpdated(address user, uint256 roles)`, where `roles` is the
 * post-update full bitfield for `user` (NOT a delta). Replaying the
 * stream `state[user] = roles` reconstructs the current role-holder map.
 *
 * Mirrors `grunt/src/request/Request.sol` and
 * `solady/src/auth/OwnableRoles.sol`.
 */
export const requestAbi = [
  // ── Ownable.owner() ─────────────────────────────────────────────────
  {
    type: "function",
    stateMutability: "view",
    name: "owner",
    inputs: [],
    outputs: [{ name: "result", type: "address" }],
  },
  // ── OwnableRoles.hasAllRoles(user, roles) ───────────────────────────
  {
    type: "function",
    stateMutability: "view",
    name: "hasAllRoles",
    inputs: [
      { name: "user", type: "address" },
      { name: "roles", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  // ── OwnableRoles.RolesUpdated(user, roles) ──────────────────────────
  // Both args indexed in solady. `roles` is the new full bitfield.
  {
    type: "event",
    name: "RolesUpdated",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "roles", type: "uint256", indexed: true },
    ],
    anonymous: false,
  },
] as const;

/**
 * Solady role bit positions for `Request`. `_ROLE_n = 1 << n`, so:
 *   - `_ROLE_PULLER   = _ROLE_0 = 1n` — granted to the address that
 *     pulls funds via `pullFunds()` (typically the Facility).
 *   - `_ROLE_CONSUMER = _ROLE_1 = 2n` — granted to the address that may
 *     call `authorizeMinting` and `consume` (typically the broker).
 *
 * From `grunt/src/request/Request.sol` lines 64 / 67.
 */
export const ROLE_PULLER = 1n << 0n; // 1n
export const ROLE_CONSUMER = 1n << 1n; // 2n
