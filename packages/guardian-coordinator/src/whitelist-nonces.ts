import {
  createWalletClient,
  custom,
  parseAbi,
  maxUint256,
  type Address,
  type LocalAccount,
  type PublicClient,
} from "viem";
import type { RequestWhitelistingBody } from "@3flabs/guardian";

const abi = parseAbi([
  "function validatorNonceFloor(address) view returns (uint256)",
  "function isNonceConsumed(address,uint256) view returns (bool)",
  "function isValidator(address) view returns (bool)",
  "function setValidatorNonceFloor(uint256)",
]);
const multicallAddress = "0xca11bde05977b3631167028862be2a173976ca11";

export function makeWhitelistNonceCandidates(options: {
  clients: Map<number, PublicClient>;
  guardianSigner: Address;
  account?: LocalAccount | undefined;
  acceptedBooks?: Map<number, Set<string>> | undefined;
  maxNonceAboveFloor: bigint;
}) {
  return async (body: RequestWhitelistingBody): Promise<string[]> => {
    const client = options.clients.get(body.chainId);
    if (!client || (await client.getChainId()) !== body.chainId)
      throw new Error("Whitelist nonce chain mismatch");
    const address = body.whitelistBook;
    if (!options.acceptedBooks?.get(body.chainId)?.has(address.toLowerCase())) {
      throw new Error("Independent whitelist nonces require an explicitly accepted whitelist book");
    }
    const validator = options.guardianSigner;
    const block = await client.getBlock();
    if (
      !(await client.readContract({
        address,
        abi,
        functionName: "isValidator",
        args: [validator],
        blockNumber: block.number,
      }))
    ) {
      throw new Error("Guardian is not a whitelist validator");
    }
    const floor = await client.readContract({
      address,
      abi,
      functionName: "validatorNonceFloor",
      args: [validator],
      blockNumber: block.number,
    });
    // Bound the RPC batch; a larger configured window can advance in safe chunks.
    const count = Number(
      options.maxNonceAboveFloor < 255n ? options.maxNonceAboveFloor + 1n : 256n,
    );
    const nonces = Array.from({ length: count }, (_, i) => floor + BigInt(i)).filter(
      (n) => n < maxUint256,
    );
    if (!nonces.length) throw new Error("Whitelist nonce space exhausted");
    const contracts = nonces.map((nonce) => ({
      address,
      abi,
      functionName: "isNonceConsumed" as const,
      args: [validator, nonce] as const,
    }));
    const consumed = await client.multicall({
      contracts,
      allowFailure: false,
      multicallAddress,
      blockNumber: block.number,
    });
    const available = nonces.filter((_, i) => !consumed[i]);
    if (available.length) return available.map(String);

    // Only finalized consumption can authorize an irreversible floor increase.
    const finalized = await client.getBlock({ blockTag: "finalized" });
    const confirmed = await client.multicall({
      contracts,
      allowFailure: false,
      multicallAddress,
      blockNumber: finalized.number,
    });
    if (!confirmed.every(Boolean))
      throw new Error("Whitelist window consumed; waiting for finality before advancing floor");
    const newFloor = floor + BigInt(nonces.length);
    if (newFloor >= maxUint256) throw new Error("Whitelist nonce space exhausted");
    if (!options.account)
      throw new Error(
        "Automatic nonce floor advancement requires a private-key, AWS KMS or GCP KMS transaction signer",
      );
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address: validator, blockTag: "latest" }),
      client.getTransactionCount({ address: validator, blockTag: "pending" }),
    ]);
    if (latest !== pending)
      throw new Error("Guardian has a pending transaction; waiting before nonce floor advancement");
    const wallet = createWalletClient({
      account: options.account,
      chain: client.chain,
      transport: custom(client),
    });
    const hash = await wallet.writeContract({
      address,
      abi,
      functionName: "setValidatorNonceFloor",
      args: [newFloor],
      chain: client.chain,
      nonce: latest,
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error("Whitelist nonce floor transaction reverted");
    // Reread the chain next poll; do not sign against a presumed floor update.
    return [];
  };
}
