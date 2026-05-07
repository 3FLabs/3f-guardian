/**
 * Minimal viem ABI for `PositionManagerFactory` (3F protocol).
 *
 *  - `isPositionManager(address)` — provenance check used by §A.3 to
 *    decide which leg of a swap is the position manager.
 *
 * Mirrors `grunt/src/manager/PositionManagerFactory.sol`.
 */
export const positionManagerFactoryAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "isPositionManager",
    inputs: [{ name: "positionManager", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
