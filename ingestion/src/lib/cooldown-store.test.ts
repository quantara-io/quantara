import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
}));

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env.TABLE_METADATA = "test-metadata";
});

describe("getLastFireBars", () => {
  it("returns an empty object when no entry exists", async () => {
    send.mockResolvedValue({ Item: undefined });
    const { getLastFireBars } = await import("./cooldown-store.js");
    const result = await getLastFireBars("BTC/USDT", "15m");
    expect(result).toEqual({});
  });

  it("returns the stored lastFireBars map", async () => {
    const stored = { "rsi-oversold": 3, "ema-cross-bull": 7 };
    send.mockResolvedValue({ Item: { metaKey: "cooldown#BTC/USDT#15m", lastFireBars: stored } });
    const { getLastFireBars } = await import("./cooldown-store.js");
    const result = await getLastFireBars("BTC/USDT", "15m");
    expect(result).toEqual(stored);
  });

  it("queries the correct metaKey", async () => {
    send.mockResolvedValue({ Item: undefined });
    const { getLastFireBars } = await import("./cooldown-store.js");
    await getLastFireBars("ETH/USDT", "1h");
    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Get");
    expect(cmd.input.Key.metaKey).toBe("cooldown#ETH/USDT#1h");
    expect(cmd.input.TableName).toBe("test-metadata");
  });
});

describe("tickCooldowns", () => {
  it("is a no-op when no entry exists", async () => {
    // First call (getLastFireBars) returns empty.
    send.mockResolvedValue({ Item: undefined });
    const { tickCooldowns } = await import("./cooldown-store.js");
    await tickCooldowns("BTC/USDT", "15m");
    // Only the GetCommand fires, not a PutCommand.
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].__cmd).toBe("Get");
  });

  it("increments all bar counters by 1", async () => {
    const stored = { "rsi-oversold": 2, "ema-cross-bull": 5 };
    send.mockResolvedValueOnce({
      Item: { metaKey: "cooldown#BTC/USDT#15m", lastFireBars: stored },
    });
    send.mockResolvedValueOnce({});
    const { tickCooldowns } = await import("./cooldown-store.js");
    await tickCooldowns("BTC/USDT", "15m");

    // Two calls: Get then Put.
    expect(send).toHaveBeenCalledTimes(2);
    const putCmd = send.mock.calls[1][0];
    expect(putCmd.__cmd).toBe("Put");
    expect(putCmd.input.Item.lastFireBars).toEqual({ "rsi-oversold": 3, "ema-cross-bull": 6 });
    expect(putCmd.input.Item.metaKey).toBe("cooldown#BTC/USDT#15m");
  });

  it("writes to the correct table", async () => {
    const stored = { "rule-a": 1 };
    send.mockResolvedValueOnce({
      Item: { metaKey: "cooldown#BTC/USDT#15m", lastFireBars: stored },
    });
    send.mockResolvedValueOnce({});
    const { tickCooldowns } = await import("./cooldown-store.js");
    await tickCooldowns("BTC/USDT", "15m");
    const putCmd = send.mock.calls[1][0];
    expect(putCmd.input.TableName).toBe("test-metadata");
  });
});

describe("recordRuleFires", () => {
  it("is a no-op when ruleNames array is empty", async () => {
    const { recordRuleFires } = await import("./cooldown-store.js");
    await recordRuleFires("BTC/USDT", "15m", []);
    expect(send).not.toHaveBeenCalled();
  });

  it("resets the fired rules' counters to 0", async () => {
    const existing = { "rsi-oversold": 4, "ema-cross-bull": 2 };
    // getLastFireBars call returns existing state.
    send.mockResolvedValueOnce({
      Item: { metaKey: "cooldown#BTC/USDT#15m", lastFireBars: existing },
    });
    send.mockResolvedValueOnce({});
    const { recordRuleFires } = await import("./cooldown-store.js");
    await recordRuleFires("BTC/USDT", "15m", ["rsi-oversold"]);

    const putCmd = send.mock.calls[1][0];
    expect(putCmd.__cmd).toBe("Put");
    expect(putCmd.input.Item.lastFireBars["rsi-oversold"]).toBe(0);
    // Non-fired rule counter is preserved.
    expect(putCmd.input.Item.lastFireBars["ema-cross-bull"]).toBe(2);
  });

  it("adds new rule entries at 0 when they didn't exist before", async () => {
    // No existing entry.
    send.mockResolvedValueOnce({ Item: undefined });
    send.mockResolvedValueOnce({});
    const { recordRuleFires } = await import("./cooldown-store.js");
    await recordRuleFires("BTC/USDT", "15m", ["macd-cross-bull"]);

    const putCmd = send.mock.calls[1][0];
    expect(putCmd.input.Item.lastFireBars["macd-cross-bull"]).toBe(0);
  });

  it("resets all rules listed in ruleNames to 0", async () => {
    const existing = { "rule-a": 5, "rule-b": 3, "rule-c": 1 };
    send.mockResolvedValueOnce({
      Item: { metaKey: "cooldown#BTC/USDT#1h", lastFireBars: existing },
    });
    send.mockResolvedValueOnce({});
    const { recordRuleFires } = await import("./cooldown-store.js");
    await recordRuleFires("BTC/USDT", "1h", ["rule-a", "rule-b"]);

    const putCmd = send.mock.calls[1][0];
    expect(putCmd.input.Item.lastFireBars["rule-a"]).toBe(0);
    expect(putCmd.input.Item.lastFireBars["rule-b"]).toBe(0);
    expect(putCmd.input.Item.lastFireBars["rule-c"]).toBe(1); // not fired, preserved
  });
});
