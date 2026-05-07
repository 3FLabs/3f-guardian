/**
 * One-shot deployment of the on-chain stack the Guardian's checks +
 * sign-runners exercise. Mirrors `grunt/test/facility/FacilityBase.t.sol`
 * (without Morpho — we don't need a real borrow market for any §A check).
 *
 * Both production contracts that use `_disableInitializers()` in their
 * constructor (Facility, TransferGuard) are deployed behind an EIP-1167
 * minimal proxy so `initialize` is callable. RequestFactory and
 * PositionManagerFactory are direct deploys; the Request and
 * PositionManager they mint are real beacon proxies (the factories'
 * own job).
 *
 * RequestWhitelist sits behind an ERC-1967 proxy deployed via a fresh
 * solady `ERC1967Factory` (mirrors `Deploy.s.sol`'s strategy, minus the
 * cross-chain CREATE2 dance — for tests we don't need a deterministic
 * address; what matters is that the proxy is a proper ERC-1967 so
 * `eip712Domain()` returns the right domain).
 */

import {
  type Abi,
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  parseAbi,
  parseAbiParameters,
  parseEventLogs,
} from "viem";

import { testAccounts } from "./accounts.js";
import { artifacts } from "./artifacts.js";
import { MULTICALL3_ADDRESS, type IntegrationClients } from "./clients.js";

/* ---------- AddressBook ---------------------------------------------- */

export type DeployedAccount = {
  readonly address: Address;
  readonly privateKey: Hex;
  readonly account: import("viem").Account;
};

export type AddressBook = {
  readonly chainId: 31337;
  readonly facility: Address;
  readonly intentDescriptor: Address;
  readonly transferGuard: Address;
  readonly positionManagerFactory: Address;
  readonly positionManager: Address;
  readonly requestFactory: Address;
  readonly request: Address;
  readonly whitelistBook: Address;
  readonly whitelistBookImpl: Address;
  readonly erc1967Factory: Address;
  readonly mockFund: Address;
  readonly tokens: {
    readonly collateral: Address;
    readonly debt: Address;
  };
  readonly accounts: {
    readonly deployer: DeployedAccount;
    readonly owner: DeployedAccount;
    readonly facilitator: DeployedAccount;
    readonly guardian: DeployedAccount;
    readonly puller: DeployedAccount;
    readonly consumer: DeployedAccount;
    readonly validator1: DeployedAccount;
    readonly validator2: DeployedAccount;
    readonly validator3: DeployedAccount;
  };
};

/* ---------- helpers --------------------------------------------------- */

/** EIP-1167 minimal-proxy bytecode targeting `impl`. */
function minimalProxyInitcode(impl: Address): Hex {
  const a = impl.toLowerCase().replace(/^0x/, "");
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${a}5af43d82803e903d91602b57fd5bf3` as Hex;
}

async function sendDeploy(client: IntegrationClients, bytecode: Hex): Promise<Address> {
  const hash = await client.walletClient.deployContract({
    abi: [] as unknown as Abi,
    bytecode,
    account: client.account,
    chain: client.walletClient.chain,
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deploy: no contractAddress in receipt");
  return receipt.contractAddress;
}

async function deployArtifact(
  client: IntegrationClients,
  artifactName: keyof typeof artifacts,
  args: readonly unknown[],
  ctorParamSig: string,
): Promise<Address> {
  const a = artifacts[artifactName];
  const ctorArgs =
    args.length > 0
      ? encodeAbiParameters(parseAbiParameters(ctorParamSig), args as readonly unknown[])
      : "0x";
  const initcode = (a.bytecode + (ctorArgs as string).slice(2)) as Hex;
  return sendDeploy(client, initcode);
}

async function sendOwnerTx(client: IntegrationClients, to: Address, data: Hex): Promise<Hex> {
  const hash = await client.walletClient.sendTransaction({
    account: testAccounts.owner.account,
    chain: client.walletClient.chain,
    to,
    data,
  });
  await client.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/* ---------- main entrypoint ------------------------------------------ */

export type DeployOptions = {
  /** Override request `repaymentDeadline`. Defaults to `now + 30 days`. */
  readonly requestRepaymentDeadline?: bigint;
  /** Override RequestWhitelist quorum. Defaults to 1. */
  readonly whitelistQuorum?: number;
};

export async function deployGuardianStack(
  client: IntegrationClients,
  opts?: DeployOptions,
): Promise<AddressBook> {
  const { owner, facilitator, guardian, puller, consumer, validator1, validator2, validator3 } =
    testAccounts;

  // Fund all role-bearing test accounts so they can pay gas.
  await Promise.all(
    [owner, facilitator, guardian, puller, consumer, validator1, validator2, validator3].map((a) =>
      client.testClient.setBalance({ address: a.address, value: 10n ** 20n }),
    ),
  );

  /* 0. Multicall3 at the canonical address (anvil doesn't ship it) --- */
  await client.testClient.setCode({
    address: MULTICALL3_ADDRESS,
    bytecode: artifacts.Multicall3.deployedBytecode,
  });

  /* 1. ERC20 mocks ---------------------------------------------------- */
  const collateral = await deployArtifact(
    client,
    "MockERC20",
    ["Collateral", "COLL", 18],
    "string,string,uint8",
  );
  const debt = await deployArtifact(
    client,
    "MockERC20",
    ["Debt", "DEBT", 18],
    "string,string,uint8",
  );

  /* 2. IntentDescriptor ---------------------------------------------- */
  const intentDescriptor = await deployArtifact(client, "IntentDescriptor", [], "");

  /* 3. TransferGuard impl + clone + init ----------------------------- */
  const tgImpl = await deployArtifact(client, "TransferGuard", [], "");
  const transferGuard = await sendDeploy(client, minimalProxyInitcode(tgImpl));
  await sendOwnerTx(
    client,
    transferGuard,
    encodeFunctionData({
      abi: parseAbi(["function initialize(address)"]),
      functionName: "initialize",
      args: [owner.address],
    }),
  );

  /* 4. Facility impl + clone + init --------------------------------- */
  const facImpl = await deployArtifact(client, "Facility", [], "");
  const facility = await sendDeploy(client, minimalProxyInitcode(facImpl));
  await sendOwnerTx(
    client,
    facility,
    encodeFunctionData({
      abi: parseAbi(["function initialize(address,address,address)"]),
      functionName: "initialize",
      args: [owner.address, facilitator.address, intentDescriptor],
    }),
  );
  // GUARDIAN_ROLE = _ROLE_1 = 2
  await sendOwnerTx(
    client,
    facility,
    encodeFunctionData({
      abi: parseAbi(["function grantRoles(address,uint256)"]),
      functionName: "grantRoles",
      args: [guardian.address, 2n],
    }),
  );

  /* 5. PositionManagerFactory + a real PM --------------------------- */
  const positionManagerFactory = await deployArtifact(
    client,
    "PositionManagerFactory",
    [owner.address],
    "address",
  );
  const pmCreateData = encodeFunctionData({
    abi: artifacts.PositionManagerFactory.abi,
    functionName: "createPositionManager",
    args: [
      owner.address,
      {
        name: "PMS",
        symbol: "PMS",
        collateralAsset: collateral,
        debtAsset: debt,
      },
      700000000000000000n, // 0.7e18 LTV
      transferGuard,
      0, // maxRebalanceLoss
      0, // rebalanceCooldown
    ],
  });
  const pmHash = await client.walletClient.sendTransaction({
    account: owner.account,
    chain: client.walletClient.chain,
    to: positionManagerFactory,
    data: pmCreateData,
  });
  const pmReceipt = await client.publicClient.waitForTransactionReceipt({ hash: pmHash });
  const pmCreated = parseEventLogs({
    abi: artifacts.PositionManagerFactory.abi,
    logs: pmReceipt.logs,
    eventName: "PositionManagerCreated",
  });
  if (pmCreated.length === 0) throw new Error("PositionManagerCreated event missing");
  const positionManager = (pmCreated[0] as unknown as { args: { positionManager: Address } }).args
    .positionManager;

  /* 6. RequestFactory + a real Request ------------------------------ */
  const requestFactory = await deployArtifact(client, "RequestFactory", [owner.address], "address");
  const block = await client.publicClient.getBlock();
  const repaymentDeadline =
    opts?.requestRepaymentDeadline ?? BigInt(block.timestamp) + 30n * 24n * 3600n;
  const reqCreateData = encodeFunctionData({
    abi: artifacts.RequestFactory.abi,
    functionName: "createRequest",
    args: [
      owner.address,
      puller.address,
      consumer.address,
      debt,
      "Test",
      "TR",
      repaymentDeadline,
      0,
    ],
  });
  const reqHash = await client.walletClient.sendTransaction({
    account: owner.account,
    chain: client.walletClient.chain,
    to: requestFactory,
    data: reqCreateData,
  });
  const reqReceipt = await client.publicClient.waitForTransactionReceipt({ hash: reqHash });
  const reqCreated = parseEventLogs({
    abi: artifacts.RequestFactory.abi,
    logs: reqReceipt.logs,
    eventName: "RequestCreated",
  });
  if (reqCreated.length === 0) throw new Error("RequestCreated event missing");
  const request = (reqCreated[0] as unknown as { args: { request: Address } }).args.request;

  /* 7. RequestWhitelist via fresh ERC1967Factory -------------------- */
  const whitelistBookImpl = await deployArtifact(client, "RequestWhitelist", [], "");
  const erc1967Factory = await deployArtifact(client, "ERC1967Factory", [], "");
  // Three validators so the contract's `quorum_ < validators_.length`
  // invariant accepts up to quorum=2 (needed for the §7.6 e2e tests).
  const wlInitData = encodeFunctionData({
    abi: parseAbi(["function initialize(address,address[],uint16,address[])"]),
    functionName: "initialize",
    args: [
      owner.address,
      [validator1.address, validator2.address, validator3.address],
      opts?.whitelistQuorum ?? 1,
      [],
    ],
  });
  const proxyDeployHash = await client.walletClient.sendTransaction({
    account: owner.account,
    chain: client.walletClient.chain,
    to: erc1967Factory,
    data: encodeFunctionData({
      abi: artifacts.ERC1967Factory.abi,
      functionName: "deployAndCall",
      args: [whitelistBookImpl, owner.address, wlInitData],
    }),
  });
  const proxyReceipt = await client.publicClient.waitForTransactionReceipt({
    hash: proxyDeployHash,
  });
  const wlDeployed = parseEventLogs({
    abi: artifacts.ERC1967Factory.abi,
    logs: proxyReceipt.logs,
    eventName: "Deployed",
  });
  if (wlDeployed.length === 0) throw new Error("ERC1967Factory.Deployed event missing");
  const whitelistBook = (wlDeployed[0] as unknown as { args: { proxy: Address } }).args.proxy;

  /* 8. OwnableMockFund ---------------------------------------------- */
  const mockFund = await deployArtifact(
    client,
    "OwnableMockFund",
    [owner.address, debt, collateral],
    "address,address,address",
  );

  /* 9. Create an Intent on the Facility ----------------------------- */
  // Several §A checks (notably §A.2 fund-binding) read
  // `facility.getIntent(id)` and revert if no intent exists. We
  // create one with id=1 and depositAsset = positionManager so the
  // facility's "at least one PM" rule is satisfied.
  const blockNow = await client.publicClient.getBlock();
  const createIntentData = encodeFunctionData({
    abi: artifacts.Facility.abi,
    functionName: "createIntent",
    args: [
      {
        depositAsset: { asset: positionManager, isPositionManager: true },
        targetAsset: { asset: debt, isPositionManager: false },
        depositCap: 1_000_000n * 10n ** 18n,
        guardKey: positionManager,
        resolveStart: Number(BigInt(blockNow.timestamp) + 24n * 3600n),
        quorum: 1,
        transferableIntent: true,
      },
    ],
  });
  await sendOwnerTx(client, facility, createIntentData);

  return {
    chainId: 31337,
    facility,
    intentDescriptor,
    transferGuard,
    positionManagerFactory,
    positionManager,
    requestFactory,
    request,
    whitelistBook,
    whitelistBookImpl,
    erc1967Factory,
    mockFund,
    tokens: { collateral, debt },
    accounts: {
      deployer: testAccounts.deployer,
      owner,
      facilitator,
      guardian,
      puller,
      consumer,
      validator1,
      validator2,
      validator3,
    },
  };
}
