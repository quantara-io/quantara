import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "aws-lambda";

const backfillCandlesMock = vi.fn().mockResolvedValue(42);

vi.mock("./exchanges/backfill.js", () => ({
  backfillCandles: backfillCandlesMock,
}));

beforeEach(() => {
  vi.resetModules();
  backfillCandlesMock.mockReset().mockResolvedValue(42);
});

const fakeContext = {} as Context;

describe("backfill-handler", () => {
  it("passes explicit days value through to backfillCandles", async () => {
    const { handler } = await import("./backfill-handler.js");
    await handler({ exchange: "kraken", pair: "BTC/USDT", timeframe: "1h", days: 30 }, fakeContext);
    expect(backfillCandlesMock).toHaveBeenCalledWith(expect.objectContaining({ days: 30 }));
  });

  it("defaults days to 7 when not supplied in the event payload", async () => {
    const { handler } = await import("./backfill-handler.js");
    // Cast to omit optional fields — simulates a Lambda payload without `days`.
    await handler({ exchange: "kraken", pair: "BTC/USDT" } as never, fakeContext);
    expect(backfillCandlesMock).toHaveBeenCalledWith(expect.objectContaining({ days: 7 }));
  });

  it("returns { total } from backfillCandles", async () => {
    const { handler } = await import("./backfill-handler.js");
    const result = await handler(
      { exchange: "kraken", pair: "BTC/USDT", timeframe: "1h", days: 7 },
      fakeContext,
    );
    expect(result).toEqual({ total: 42 });
  });

  it("throws when exchange is missing", async () => {
    const { handler } = await import("./backfill-handler.js");
    await expect(handler({ pair: "BTC/USDT" } as never, fakeContext)).rejects.toThrow(
      /Missing required fields/,
    );
  });

  it("throws when pair is missing", async () => {
    const { handler } = await import("./backfill-handler.js");
    await expect(handler({ exchange: "kraken" } as never, fakeContext)).rejects.toThrow(
      /Missing required fields/,
    );
  });

  it("forwards force=true to backfillCandles when provided", async () => {
    const { handler } = await import("./backfill-handler.js");
    await handler(
      { exchange: "kraken", pair: "BTC/USDT", timeframe: "1h", days: 90, force: true },
      fakeContext,
    );
    expect(backfillCandlesMock).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it("defaults force to false when not provided in the event payload", async () => {
    const { handler } = await import("./backfill-handler.js");
    await handler({ exchange: "kraken", pair: "BTC/USDT", timeframe: "1h", days: 7 }, fakeContext);
    expect(backfillCandlesMock).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
  });

  it("forwards targetTable to backfillCandles when provided", async () => {
    const { handler } = await import("./backfill-handler.js");
    await handler(
      {
        exchange: "kraken",
        pair: "BTC/USDT",
        timeframe: "1h",
        days: 365,
        force: true,
        targetTable: "quantara-dev-candles-archive",
      },
      fakeContext,
    );
    expect(backfillCandlesMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetTable: "quantara-dev-candles-archive" }),
    );
  });

  it("omits targetTable from backfillCandles call when not provided", async () => {
    const { handler } = await import("./backfill-handler.js");
    await handler({ exchange: "kraken", pair: "BTC/USDT", timeframe: "1h", days: 7 }, fakeContext);
    const callArg = backfillCandlesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty("targetTable");
  });
});
