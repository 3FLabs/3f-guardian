// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  OwnableMockFund
/// @notice Bare-minimum stand-in for a 3F Fund (`grunt/src/funds/...`) used
///         by the Guardian §A.2 (`intent-fund-binding`) integration tests.
///
///         Exposes exactly the surface the Guardian's `fundAbi` reads:
///
///           - `owner()` (Ownable)        — accepted-owners check
///           - `state(Order)` (IFund)     — proposed-fund clean check
///           - `asset()` / `share()`      — bookkeeping in error envelopes
///           - `hasAllRoles(user, roles)` — DEPOSITOR_ROLE check (skipped
///                                          in v1 but kept in the surface)
///
///         Mirrors the storage names the production `ParetoFund` uses for
///         these views. Setters (`setOwner`, `setOrderState`,
///         `setRoles`) are unauthenticated on purpose so tests can drive
///         it directly without role wiring; the surface is identical to
///         what the Guardian reads, which is what matters.
contract OwnableMockFund {
  address public ownerAddr;
  address public assetAddr;
  address public shareAddr;

  // mapping(orderId => state). `state(Order)` re-derives the orderId.
  mapping(bytes32 => uint8) public stateById;
  // mapping(user => roles bitfield)
  mapping(address => uint256) public rolesOf;

  struct Order {
    uint8 mode;
    address owner_;
    address receiver;
    uint256 input;
    uint256 output;
    bytes32 salt;
  }

  constructor(address owner_, address asset_, address share_) {
    ownerAddr = owner_;
    assetAddr = asset_;
    shareAddr = share_;
  }

  function owner() external view returns (address) {
    return ownerAddr;
  }

  function asset() external view returns (address) {
    return assetAddr;
  }

  function share() external view returns (address) {
    return shareAddr;
  }

  function state(Order calldata order) external view returns (uint8) {
    bytes32 id = keccak256(abi.encode(block.chainid, address(this), order));
    return stateById[id];
  }

  function hasAllRoles(address user, uint256 roles) external view returns (bool) {
    return (rolesOf[user] & roles) == roles;
  }

  // ── test setters (unauthenticated by design) ────────────────────────

  function setOwner(address newOwner) external {
    ownerAddr = newOwner;
  }

  function setOrderState(Order calldata order, uint8 s) external {
    bytes32 id = keccak256(abi.encode(block.chainid, address(this), order));
    stateById[id] = s;
  }

  function setRoles(address user, uint256 roles) external {
    rolesOf[user] = roles;
  }
}
