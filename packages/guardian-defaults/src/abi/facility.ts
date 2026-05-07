/**
 * Minimal viem ABI for `IFacility` (3F protocol). Only the view methods
 * needed by Appendix-A check builders are included.
 *
 * Mirrors `grunt/src/interfaces/facility/IFacility.sol` and the embedded
 * structs from `grunt/src/libs/facility/LibIntent.sol`
 * (`IntentProperties`, `Asset`) and `grunt/src/libs/funds/Order.sol`
 * (`Order`).
 */
export const facilityAbi = [
  // ── IFacilityIntents.getIntent(uint256) ─────────────────────────────
  // returns (IntentProperties properties, address fund, address request, bool resolved)
  {
    type: "function",
    stateMutability: "view",
    name: "getIntent",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "properties",
        type: "tuple",
        components: [
          {
            name: "depositAsset",
            type: "tuple",
            components: [
              { name: "asset", type: "address" },
              { name: "isPositionManager", type: "bool" },
            ],
          },
          {
            name: "targetAsset",
            type: "tuple",
            components: [
              { name: "asset", type: "address" },
              { name: "isPositionManager", type: "bool" },
            ],
          },
          { name: "depositCap", type: "uint256" },
          { name: "guardKey", type: "address" },
          { name: "resolveStart", type: "uint40" },
          { name: "quorum", type: "uint8" },
          { name: "transferableIntent", type: "bool" },
        ],
      },
      { name: "fund", type: "address" },
      { name: "request", type: "address" },
      { name: "resolved", type: "bool" },
    ],
  },
  // ── IFacilityFunds.getOrder(uint256) ────────────────────────────────
  // returns (Order order, bytes32 orderId)
  {
    type: "function",
    stateMutability: "view",
    name: "getOrder",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "mode", type: "uint8" },
          { name: "owner", type: "address" },
          { name: "receiver", type: "address" },
          { name: "input", type: "uint256" },
          { name: "output", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "orderId", type: "bytes32" },
    ],
  },
] as const;
