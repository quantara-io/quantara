import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IndicatorState } from "@quantara/shared";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
}));

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env.TABLE_INDICATOR_STATE = "test-indicator-state";
});

function makeState(overrides: Partial<IndicatorState> = {}): IndicatorState {
  return {
    pair: "BTC/USDT",
    exchange: "binanceus",
    timeframe: "15m",
    asOf: 1700000000000,
    barsSinceStart: 100,
    rsi14: 55.2,
    ema20: 29000,
    ema50: 28500,
    ema200: 27000,
    macdLine: 120.5,
    macdSignal: 100.0,
    macdHist: 20.5,
    atr14: 500,
    bbUpper: 30000,
    bbMid: 29000,
    bbLower: 28000,
    bbWidth: 0.069,
    obv: 1_000_000,
    obvSlope: 500,
    vwap: 29100,
    volZ: 1.2,
    realizedVolAnnualized: 0.65,
    fearGreed: 72,
    dispersion: 0.003,
    history: {
      rsi14: [54, 55, 55.2],
      macdHist: [18, 19, 20.5],
      ema20: [28900, 28950, 29000],
      ema50: [28400, 28450, 28500],
      close: [28950, 29000, 29050],
      volume: [10, 11, 12],
    },
    ...overrides,
  };
}

describe("putIndicatorState", () => {
  it("writes a PutCommand with the correct pk and asOf sort key", async () => {
    send.mockResolvedValue({});
    const state = makeState();
    const { putIndicatorState } = await import("./indicator-state-store.js");
    await putIndicatorState(state);

    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Put");
    expect(cmd.input.TableName).toBe("test-indicator-state");
    const item = cmd.input.Item;
    expect(item.pk).toBe("BTC/USDT#binanceus#15m");
    expect(item.asOf).toBe(new Date(1700000000000).toISOString());
    expect(item.pair).toBe("BTC/USDT");
    expect(item.exchange).toBe("binanceus");
    expect(item.timeframe).toBe("15m");
    expect(item.asOfMs).toBe(1700000000000);
    expect(item.barsSinceStart).toBe(100);
    // TTL should be set ~7 days from now
    const nowSec = Math.floor(Date.now() / 1000);
    expect(item.ttl).toBeGreaterThanOrEqual(nowSec + 86400 * 7 - 5);
    expect(item.ttl).toBeLessThanOrEqual(nowSec + 86400 * 7 + 5);
  });

  it("serializes the history ring-buffer as a nested object", async () => {
    send.mockResolvedValue({});
    const state = makeState();
    const { putIndicatorState } = await import("./indicator-state-store.js");
    await putIndicatorState(state);

    const item = send.mock.calls[0][0].input.Item;
    expect(item.history).toEqual(state.history);
  });

  it("includes null indicator fields without throwing", async () => {
    send.mockResolvedValue({});
    const state = makeState({
      rsi14: null,
      ema20: null,
      macdLine: null,
      vwap: null,
    });
    const { putIndicatorState } = await import("./indicator-state-store.js");
    await expect(putIndicatorState(state)).resolves.toBeUndefined();
    const item = send.mock.calls[0][0].input.Item;
    expect(item.rsi14).toBeNull();
    expect(item.ema20).toBeNull();
  });

  it("does not mutate the input state", async () => {
    send.mockResolvedValue({});
    const state = makeState();
    const originalAsOf = state.asOf;
    const originalPair = state.pair;
    const { putIndicatorState } = await import("./indicator-state-store.js");
    await putIndicatorState(state);
    expect(state.asOf).toBe(originalAsOf);
    expect(state.pair).toBe(originalPair);
  });

  it("builds pk as pair#exchange#timeframe", async () => {
    send.mockResolvedValue({});
    const state = makeState({ pair: "ETH/USDT", exchange: "coinbase", timeframe: "1h" });
    const { putIndicatorState } = await import("./indicator-state-store.js");
    await putIndicatorState(state);
    const item = send.mock.calls[0][0].input.Item;
    expect(item.pk).toBe("ETH/USDT#coinbase#1h");
  });
});

describe("getLatestIndicatorState", () => {
  it("queries by pk descending with Limit 1 and returns the reconstructed IndicatorState", async () => {
    const state = makeState();
    const storedItem = {
      pk: "BTC/USDT#binanceus#15m",
      asOf: new Date(state.asOf).toISOString(),
      pair: state.pair,
      exchange: state.exchange,
      timeframe: state.timeframe,
      asOfMs: state.asOf,
      barsSinceStart: state.barsSinceStart,
      rsi14: state.rsi14,
      ema20: state.ema20,
      ema50: state.ema50,
      ema200: state.ema200,
      macdLine: state.macdLine,
      macdSignal: state.macdSignal,
      macdHist: state.macdHist,
      atr14: state.atr14,
      bbUpper: state.bbUpper,
      bbMid: state.bbMid,
      bbLower: state.bbLower,
      bbWidth: state.bbWidth,
      obv: state.obv,
      obvSlope: state.obvSlope,
      vwap: state.vwap,
      volZ: state.volZ,
      realizedVolAnnualized: state.realizedVolAnnualized,
      fearGreed: state.fearGreed,
      dispersion: state.dispersion,
      history: state.history,
      ttl: Math.floor(Date.now() / 1000) + 86400 * 7,
    };
    send.mockResolvedValue({ Items: [storedItem] });

    const { getLatestIndicatorState } = await import("./indicator-state-store.js");
    const result = await getLatestIndicatorState("BTC/USDT", "binanceus", "15m");

    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Query");
    expect(cmd.input.ScanIndexForward).toBe(false);
    expect(cmd.input.Limit).toBe(1);
    expect(cmd.input.ExpressionAttributeValues).toEqual({ ":pk": "BTC/USDT#binanceus#15m" });

    // Round-trip: result should equal original state (ttl is not on IndicatorState)
    expect(result).not.toBeNull();
    expect(result!.pair).toBe(state.pair);
    expect(result!.exchange).toBe(state.exchange);
    expect(result!.timeframe).toBe(state.timeframe);
    expect(result!.asOf).toBe(state.asOf);
    expect(result!.barsSinceStart).toBe(state.barsSinceStart);
    expect(result!.rsi14).toBe(state.rsi14);
    expect(result!.history).toEqual(state.history);
  });

  it("returns null when no item exists", async () => {
    send.mockResolvedValue({ Items: [] });
    const { getLatestIndicatorState } = await import("./indicator-state-store.js");
    const result = await getLatestIndicatorState("BTC/USDT", "binanceus", "15m");
    expect(result).toBeNull();
  });

  it("returns null when DynamoDB returns undefined Items", async () => {
    send.mockResolvedValue({});
    const { getLatestIndicatorState } = await import("./indicator-state-store.js");
    const result = await getLatestIndicatorState("BTC/USDT", "binanceus", "15m");
    expect(result).toBeNull();
  });

  it("reads from the correct table", async () => {
    send.mockResolvedValue({ Items: [] });
    const { getLatestIndicatorState } = await import("./indicator-state-store.js");
    await getLatestIndicatorState("BTC/USDT", "binanceus", "15m");
    expect(send.mock.calls[0][0].input.TableName).toBe("test-indicator-state");
  });

  it("round-trips null indicator values correctly", async () => {
    const state = makeState({ rsi14: null, ema20: null, vwap: null });
    const storedItem = {
      pk: "BTC/USDT#binanceus#15m",
      asOf: new Date(state.asOf).toISOString(),
      pair: state.pair,
      exchange: state.exchange,
      timeframe: state.timeframe,
      asOfMs: state.asOf,
      barsSinceStart: state.barsSinceStart,
      // null fields omitted — DDB DocumentClient does not store them
      ema50: state.ema50,
      ema200: state.ema200,
      macdLine: state.macdLine,
      macdSignal: state.macdSignal,
      macdHist: state.macdHist,
      atr14: state.atr14,
      bbUpper: state.bbUpper,
      bbMid: state.bbMid,
      bbLower: state.bbLower,
      bbWidth: state.bbWidth,
      obv: state.obv,
      obvSlope: state.obvSlope,
      volZ: state.volZ,
      realizedVolAnnualized: state.realizedVolAnnualized,
      fearGreed: state.fearGreed,
      dispersion: state.dispersion,
      history: state.history,
      ttl: Math.floor(Date.now() / 1000) + 86400 * 7,
    };
    send.mockResolvedValue({ Items: [storedItem] });
    const { getLatestIndicatorState } = await import("./indicator-state-store.js");
    const result = await getLatestIndicatorState("BTC/USDT", "binanceus", "15m");
    expect(result!.rsi14).toBeNull();
    expect(result!.ema20).toBeNull();
    expect(result!.vwap).toBeNull();
  });
});
