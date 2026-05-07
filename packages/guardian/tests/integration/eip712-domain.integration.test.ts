import { beforeAll, describe, expect, it } from "vitest";

import { fetchEip712DomainNameVersion } from "../../src/lib/eip712-domain.js";
import { createIntegrationFixture } from "@3flabs/guardian-test-fixtures";

describe("fetchEip712DomainNameVersion — on-chain", () => {
  const fixture = createIntegrationFixture();
  beforeAll(fixture.setup);

  it('reads { name: "3F", version: "1" } from the Facility (grunt\'s solady EIP712)', async () => {
    const { book, clients } = fixture.snapshot();
    const res = await fetchEip712DomainNameVersion({
      client: clients.publicClient,
      chainId: book.chainId,
      verifyingContract: book.facility,
    });
    expect(res.isOk(), res.isErr() ? res.error.message : "").toBe(true);
    if (!res.isOk()) return;
    expect(res.value).toEqual({ name: "3F", version: "1" });
  });

  it('reads { name: "3fRequestWhitelist", version: "1" } from the RequestWhitelist proxy', async () => {
    const { book, clients } = fixture.snapshot();
    const res = await fetchEip712DomainNameVersion({
      client: clients.publicClient,
      chainId: book.chainId,
      verifyingContract: book.whitelistBook,
    });
    expect(res.isOk(), res.isErr() ? res.error.message : "").toBe(true);
    if (!res.isOk()) return;
    expect(res.value).toEqual({ name: "3fRequestWhitelist", version: "1" });
  });

  it("returns UpstreamUnavailable when the verifying contract has no eip712Domain() (e.g. a plain MockERC20)", async () => {
    const { book, clients } = fixture.snapshot();
    const res = await fetchEip712DomainNameVersion({
      client: clients.publicClient,
      chainId: book.chainId,
      verifyingContract: book.tokens.collateral,
    });
    expect(res.isErr()).toBe(true);
  });

  it("amortises subsequent reads when a cache is provided", async () => {
    const { book, clients } = fixture.snapshot();
    const store = new Map<string, { name: string; version: string }>();
    const cache = {
      async get(k: string) {
        return store.get(k);
      },
      async set(k: string, v: { name: string; version: string }) {
        store.set(k, v);
      },
    };
    const r1 = await fetchEip712DomainNameVersion({
      client: clients.publicClient,
      chainId: book.chainId,
      verifyingContract: book.facility,
      cache,
    });
    const r2 = await fetchEip712DomainNameVersion({
      client: clients.publicClient,
      chainId: book.chainId,
      verifyingContract: book.facility,
      cache,
    });
    expect(r1.isOk() && r2.isOk()).toBe(true);
    expect(store.size).toBe(1);
  });
});
