import { describe, it, expect } from "vitest";

import { getSymbol, EXCHANGES, PAIRS } from "./config.js";

describe("getSymbol", () => {
  it("returns the pair unchanged when no override exists", () => {
    expect(getSymbol("binanceus", "BTC/USDT")).toBe("BTC/USDT");
    expect(getSymbol("kraken", "ETH/USDT")).toBe("ETH/USDT");
  });

  it("translates BTC/USDT -> BTC/USD on coinbase (USDT not quoted there)", () => {
    expect(getSymbol("coinbase", "BTC/USDT")).toBe("BTC/USD");
  });

  it("translates every USDT pair to USD on coinbase", () => {
    for (const pair of PAIRS) {
      const symbol = getSymbol("coinbase", pair);
      expect(symbol).toMatch(/\/USD$/);
    }
  });
});

describe("EXCHANGES + PAIRS", () => {
  it("declares the expected exchanges as a const tuple", () => {
    expect(EXCHANGES).toEqual(["binanceus", "coinbase", "kraken"]);
  });

  it("declares 5 trading pairs all quoted in USDT", () => {
    expect(PAIRS).toHaveLength(5);
    for (const p of PAIRS) expect(p).toMatch(/\/USDT$/);
  });
});
