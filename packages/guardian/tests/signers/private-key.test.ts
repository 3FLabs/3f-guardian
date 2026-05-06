import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Hex } from "viem";

import { privateKeyToSignTypedData } from "../../src/signers/private-key.js";

const PK: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const TYPED_DATA = {
  domain: {
    name: "Guardian",
    version: "1",
    chainId: 1,
    verifyingContract: "0x0000000000000000000000000000000000000001",
  },
  types: {
    Mail: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  message: {
    from: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
    to: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
    contents: "Hello, Bob!",
  },
} as const;

describe("privateKeyToSignTypedData", () => {
  it("produces a signature that recovers to the key's account", async () => {
    const sign = privateKeyToSignTypedData(PK);
    const account = privateKeyToAccount(PK);

    const result = await sign(TYPED_DATA);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const signature = result.value;
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);

    const verified = await verifyTypedData({
      address: account.address,
      ...TYPED_DATA,
      signature,
    });
    expect(verified).toBe(true);
  });

  it("is deterministic for the same payload (§8 idempotency)", async () => {
    const sign = privateKeyToSignTypedData(PK);
    const a = await sign(TYPED_DATA);
    const b = await sign(TYPED_DATA);
    expect(a.isOk() && b.isOk()).toBe(true);
    if (!a.isOk() || !b.isOk()) return;
    expect(a.value).toBe(b.value);
  });

  it("returns Err with InternalError tag when viem throws", async () => {
    // Forcing a throw: pass a payload referencing an unknown type so
    // viem's internal `getTypesForEIP712Domain` rejects it.
    const sign = privateKeyToSignTypedData(PK);
    const result = await sign({
      domain: { name: "X", version: "1", chainId: 1 },
      types: { Mail: [{ name: "x", type: "string" }] },
      primaryType: "DoesNotExist",
      message: { x: "" },
    } as never);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error._tag).toBe("InternalError");
  });
});
