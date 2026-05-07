import { beforeAll, describe, expect, it } from "vitest";

import { createIntegrationFixture } from "@3flabs/guardian-test-fixtures";

describe("integration smoke — Guardian stack deploys cleanly", () => {
  const fixture = createIntegrationFixture();

  beforeAll(fixture.setup);

  it("populates every AddressBook slot with a deployed contract", async () => {
    const { book, clients } = fixture.snapshot();
    const contracts = [
      book.facility,
      book.intentDescriptor,
      book.transferGuard,
      book.positionManagerFactory,
      book.positionManager,
      book.requestFactory,
      book.request,
      book.whitelistBook,
      book.whitelistBookImpl,
      book.erc1967Factory,
      book.mockFund,
      book.tokens.collateral,
      book.tokens.debt,
    ];
    const codes = await Promise.all(
      contracts.map((addr) => clients.publicClient.getCode({ address: addr })),
    );
    contracts.forEach((addr, i) => {
      const code = codes[i];
      expect(code, `no code at ${addr}`).toBeDefined();
      expect(code!.length).toBeGreaterThan(2);
    });
    expect(book.chainId).toBe(31337);
  });
});
