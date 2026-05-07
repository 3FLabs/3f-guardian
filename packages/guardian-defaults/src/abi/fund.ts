/**
 * Minimal viem ABI for `IFund` (3F protocol). Only the view methods needed
 * by Appendix-A check builders are included; mutating entry points are
 * intentionally excluded so the ABI cannot be misused to write.
 *
 * Mirrors `grunt/src/interfaces/funds/IFund.sol` plus `owner()` from
 * `solady/auth/Ownable.sol` (every concrete fund inherits OwnableRoles).
 *
 * The `Order` struct comes from `grunt/src/libs/funds/Order.sol`. Field
 * names and types are kept in sync with the on-chain definition.
 */
export const fundAbi = [
  // ── Ownable.owner() ─────────────────────────────────────────────────
  {
    type: "function",
    stateMutability: "view",
    name: "owner",
    inputs: [],
    outputs: [{ name: "result", type: "address" }],
  },
  // ── IFund.state(Order) ──────────────────────────────────────────────
  {
    type: "function",
    stateMutability: "view",
    name: "state",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "mode", type: "uint8" }, // Mode enum: 0 DEPOSIT, 1 REDEEM
          { name: "owner", type: "address" },
          { name: "receiver", type: "address" },
          { name: "input", type: "uint256" },
          { name: "output", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint8" }], // State enum (see ORDER_STATE)
  },
  // ── IFund.asset() / IFund.share() ───────────────────────────────────
  {
    type: "function",
    stateMutability: "view",
    name: "asset",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "share",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  // ── OwnableRoles.hasAllRoles(user, roles) ───────────────────────────
  // Used by the (currently skipped) DEPOSITOR_ROLE check. Kept here so
  // the abi surface for the fund contract stays in one place.
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
] as const;

/**
 * `State` enum from `Order.sol`. Indexed by the uint8 returned by
 * `IFund.state(order)`. Only EMPTY and ENDED are considered "clean" for
 * the §A.2 fund-state check; everything else is an active order.
 */
export const ORDER_STATE = {
  EMPTY: 0,
  ACCEPTED: 1,
  PENDING: 2,
  PROCESSING: 3,
  UNLOCKING: 4,
  RECOVERING: 5,
  ENDED: 6,
} as const;

export type OrderState = (typeof ORDER_STATE)[keyof typeof ORDER_STATE];

export const ORDER_STATE_NAME: Readonly<Record<number, string>> = {
  [ORDER_STATE.EMPTY]: "EMPTY",
  [ORDER_STATE.ACCEPTED]: "ACCEPTED",
  [ORDER_STATE.PENDING]: "PENDING",
  [ORDER_STATE.PROCESSING]: "PROCESSING",
  [ORDER_STATE.UNLOCKING]: "UNLOCKING",
  [ORDER_STATE.RECOVERING]: "RECOVERING",
  [ORDER_STATE.ENDED]: "ENDED",
};

/**
 * `_DEPOSITOR_ROLE = _ROLE_1` in every concrete fund (Centrifuge / Pareto
 * / USCC). solady's `_ROLE_n` is `1 << n`, so role 1 is `2`. Used by the
 * (currently skipped) depositor-role check.
 */
export const DEPOSITOR_ROLE = 1n << 1n; // 2n
