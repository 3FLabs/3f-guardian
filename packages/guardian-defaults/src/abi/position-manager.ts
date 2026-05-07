/**
 * Minimal viem ABI for `PositionManager` (3F protocol).
 *
 *  - `owner()` — from `OwnableRoles`. PM is owner-only for admin ops.
 *  - `assets()` — returns `(collateralAsset, debtAsset)`.
 *  - `pendingFees()` — returns `(totalAssets, totalSupply, mgmtFeeShares,
 *    perfFeeShares)` — all four needed to compute an accurate share
 *    price that anticipates the fee shares the next on-chain tx will
 *    mint. Per the contract docstring:
 *      `price = totalAssets / (totalSupply + managementFeeShares + performanceFeeShares)`
 *    The defaults runner additionally folds in `virtualShareOffset` and
 *    `VIRTUAL_ASSETS = 1n` to match the `LibView.convertToShares` math
 *    used on-chain.
 *  - `virtualShareOffset()` — `10^(18 - debtDecimals)`, floored at 1.
 *
 * Mirrors `grunt/src/interfaces/manager/IPositionManager.sol`.
 */
export const positionManagerAbi = [
  // Ownable.owner()
  {
    type: "function",
    stateMutability: "view",
    name: "owner",
    inputs: [],
    outputs: [{ name: "result", type: "address" }],
  },
  // assets() returns (collateralAsset, debtAsset)
  {
    type: "function",
    stateMutability: "view",
    name: "assets",
    inputs: [],
    outputs: [
      { name: "collateralAsset", type: "address" },
      { name: "debtAsset", type: "address" },
    ],
  },
  // pendingFees() returns (totalAssets_, totalSupply_, managementFeeShares, performanceFeeShares)
  {
    type: "function",
    stateMutability: "view",
    name: "pendingFees",
    inputs: [],
    outputs: [
      { name: "totalAssets_", type: "uint256" },
      { name: "totalSupply_", type: "uint256" },
      { name: "managementFeeShares", type: "uint256" },
      { name: "performanceFeeShares", type: "uint256" },
    ],
  },
  // virtualShareOffset() returns uint256
  {
    type: "function",
    stateMutability: "view",
    name: "virtualShareOffset",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * `VIRTUAL_ASSETS` constant from `grunt/src/libs/manager/LibConstants.sol`.
 * Used in the `convertToShares` denominator for inflation-attack
 * protection. Always `1n` in v1; exposed here so the runner reads
 * exactly one source of truth.
 */
export const VIRTUAL_ASSETS = 1n;
