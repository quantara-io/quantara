import { describe, it, expect } from "vitest";
import { macd, macdUpdate, MacdIncrState } from "./macd.js";

function makeCloses(n = 200, seed = 99): number[] {
  let val = 100;
  const closes: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const move = ((s >>> 0) % 201 - 100) / 100;
    val = Math.max(1, val + move);
    closes.push(val);
  }
  return closes;
}

describe("macd", () => {
  const closes = makeCloses(200);
  const { line, signal, hist } = macd(closes);

  it("returns series aligned to close length", () => {
    expect(line).toHaveLength(closes.length);
    expect(signal).toHaveLength(closes.length);
    expect(hist).toHaveLength(closes.length);
  });

  it("macdLine is null for first 25 bars (26-bar EMA warmup)", () => {
    for (let i = 0; i < 25; i++) {
      expect(line[i]).toBeNull();
    }
  });

  it("macdLine is non-null from bar 25", () => {
    for (let i = 25; i < closes.length; i++) {
      expect(line[i]).not.toBeNull();
    }
  });

  it("signal is null for first 33 bars (25 + 8 additional)", () => {
    for (let i = 0; i < 33; i++) {
      expect(signal[i]).toBeNull();
    }
  });

  it("signal is non-null from bar 33", () => {
    for (let i = 33; i < closes.length; i++) {
      expect(signal[i]).not.toBeNull();
    }
  });

  it("hist = line - signal where both non-null", () => {
    for (let i = 33; i < closes.length; i++) {
      expect(hist[i]).toBeCloseTo(line[i]! - signal[i]!, 10);
    }
  });

  it("hist is null where signal is null", () => {
    for (let i = 0; i < 33; i++) {
      expect(hist[i]).toBeNull();
    }
  });
});

describe("macdUpdate — cold-start path", () => {
  /**
   * Simulate the Phase 4 scenario: IndicatorState is loaded from DDB with
   * signalEma = null (cold-start, not enough bars seen yet). EMA12 and EMA26
   * are known (they seed after 12 and 26 bars respectively) but the signal
   * EMA has not yet been seeded.
   *
   * We start the helper at the EMA state just before the first MACD bar
   * (bar 24, 0-indexed) so that bar 25 is the first macdLine value pushed
   * into the buffer. This mirrors the exact window used by the full macd()
   * recompute, allowing bit-exact comparison once the seed fires at bar 33.
   */

  /**
   * Build the incremental EMA state as it would appear after bar 25 —
   * the first bar where macdLine is defined. This is the earliest realistic
   * cold-start checkpoint: EMA12 and EMA26 have both been seeded, one
   * macdLine value exists, but the signal EMA has not been seeded yet.
   *
   * The buffer is pre-loaded with the bar-25 macdLine so the seed window
   * in macdUpdate (bars 25-33, 9 values) is identical to the one used by
   * the full-recompute macd() function.
   */
  function buildColdStateAfterBar25(closes: number[]): MacdIncrState {
    const alpha12 = 2 / 13;
    // EMA12 seeded at bar 11 via SMA(12), ticked through bar 25.
    let emaFast = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    for (let i = 12; i <= 25; i++) {
      emaFast = alpha12 * closes[i] + (1 - alpha12) * emaFast;
    }
    // EMA26 seeded at bar 25 via SMA(26).
    const emaSlow = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
    // The first macdLine value (at bar 25) goes into the buffer.
    const macdLine25 = emaFast - emaSlow;
    return {
      emaFast,
      emaSlow,
      signalEma: null,
      macdValuesSinceSeed: [macdLine25],
      signalSeedingActive: true,
    };
  }

  it("signalEma stays null for first 8 calls, seeds on 9th call", () => {
    const closes = makeCloses(50);
    let state = buildColdStateAfterBar25(closes);

    // Feed bars 26-32: 7 more bars → buffer grows from 1 to 8. Still null.
    for (let i = 26; i <= 32; i++) {
      const upd = macdUpdate(state, closes[i]);
      state = upd;
      expect(upd.signalEma).toBeNull();
      expect(upd.hist).toBeNull();
    }
    expect(state.macdValuesSinceSeed).toHaveLength(8);

    // Bar 33 is the 9th MACD value — seeding fires here.
    const upd9 = macdUpdate(state, closes[33]);
    expect(upd9.signalEma).not.toBeNull();
    expect(upd9.hist).not.toBeNull();
    expect(upd9.macdValuesSinceSeed).toHaveLength(0);
  });

  it("seeded signalEma and subsequent hist values match full recompute", () => {
    const closes = makeCloses(50);
    const { signal, hist } = macd(closes);

    let state = buildColdStateAfterBar25(closes);

    // Feed bars 26-49 incrementally.
    let lastUpd!: ReturnType<typeof macdUpdate>;
    for (let i = 26; i <= 49; i++) {
      lastUpd = macdUpdate(state, closes[i]);
      state = lastUpd;
    }

    // By bar 49, signalEma must be seeded and match the full recompute.
    expect(lastUpd.signalEma).not.toBeNull();
    expect(lastUpd.signalEma).toBeCloseTo(signal[49]!, 4);
    expect(lastUpd.hist).toBeCloseTo(hist[49]!, 4);
  });

  it.each([26, 27, 28, 29, 30, 31, 32].map((bar) => ({ bar })))(
    "bar $bar: throws when reloaded with signalSeedingActive=true and empty buffer",
    ({ bar }) => {
      const closes = makeCloses(50);

      // Build real EMA state at `bar` by running incrementally through bar-1,
      // then simulating a bad reload: signalSeedingActive=true, buffer cleared.
      let state = buildColdStateAfterBar25(closes);
      // Advance state from bar 26 up to (bar - 1) so EMA values are correct.
      for (let i = 26; i < bar; i++) {
        state = macdUpdate(state, closes[i]);
      }

      // Simulate the bad reload: warm-up was in progress but buffer was discarded.
      const badState: MacdIncrState = {
        emaFast: state.emaFast,
        emaSlow: state.emaSlow,
        signalEma: null,
        macdValuesSinceSeed: [], // buffer dropped — unrecoverable
        signalSeedingActive: true, // warm-up was active at checkpoint
      };

      expect(() => macdUpdate(badState, closes[bar])).toThrow(
        /macdUpdate: state was checkpointed during signal warm-up.*macdValuesSinceSeed is empty/,
      );
    },
  );
});

describe("macdUpdate — mid-warm-up checkpoint parity", () => {
  /**
   * Exercises the fix for issue #33: when an IndicatorState is checkpointed
   * at any bar in the signal warm-up window (bars 25-33) and later reloaded,
   * signalEma and macdHist must match the full macd() recompute.
   *
   * Two sub-scenarios:
   *   A. Bar-25 checkpoint with macdValuesSinceSeed cleared to []:
   *      Option A self-correction recovers the implicit macdLine from
   *      (emaFast - emaSlow) and seeds the buffer correctly.
   *
   *   B. Checkpoints at bars 25-33 with macdValuesSinceSeed preserved:
   *      The buffer is restored as-is; signal seeds at bar 33 in all cases.
   */

  function buildColdStateAfterBar25(closes: number[]): MacdIncrState {
    const alpha12 = 2 / 13;
    let emaFast = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    for (let i = 12; i <= 25; i++) {
      emaFast = alpha12 * closes[i] + (1 - alpha12) * emaFast;
    }
    const emaSlow = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
    const macdLine25 = emaFast - emaSlow;
    return {
      emaFast,
      emaSlow,
      signalEma: null,
      macdValuesSinceSeed: [macdLine25],
      signalSeedingActive: true,
    };
  }

  /**
   * Run macdUpdate incrementally from bar 25 through checkpointBar,
   * returning the state immediately after checkpointBar is processed.
   */
  function runIncrementalToBar(
    closes: number[],
    checkpointBar: number,
  ): MacdIncrState {
    let state = buildColdStateAfterBar25(closes);
    for (let i = 26; i <= checkpointBar; i++) {
      state = macdUpdate(state, closes[i]);
    }
    return state;
  }

  it(
    "bar-25 checkpoint with cleared buffer: Option A self-correction seeds" +
      " signal at bar 33 matching full recompute",
    () => {
      const closes = makeCloses(60);
      const { signal, hist } = macd(closes);

      // Checkpoint at bar 25 (earliest possible): buffer has [m25].
      // Simulate reload with macdValuesSinceSeed: [] and signalSeedingActive: false
      // (the only valid empty-buffer cold-start — bar-25 bootstrap path).
      const stateAt25 = buildColdStateAfterBar25(closes);
      const checkpoint: MacdIncrState = {
        ...stateAt25,
        macdValuesSinceSeed: [], // cleared, as per old JSDoc guidance
        signalSeedingActive: false, // bar-25 self-correction requires this to be false
      };

      // Feed bars 26-32: should remain null (Option A recovers [m25] so
      // the buffer grows to 8 values — still one short of seeding).
      let state = checkpoint;
      for (let i = 26; i <= 32; i++) {
        const upd = macdUpdate(state, closes[i]);
        state = upd;
        expect(upd.signalEma).toBeNull();
      }

      // Bar 33: 9th value — seeding fires at the same bar as full recompute.
      const upd33 = macdUpdate(state, closes[33]);
      expect(upd33.signalEma).not.toBeNull();
      expect(upd33.hist).not.toBeNull();

      // Continue to bar 49 and verify convergence with full recompute.
      state = upd33;
      let lastUpd = upd33;
      for (let i = 34; i <= 49; i++) {
        lastUpd = macdUpdate(state, closes[i]);
        state = lastUpd;
      }
      expect(lastUpd.signalEma).toBeCloseTo(signal[49]!, 4);
      expect(lastUpd.hist).toBeCloseTo(hist[49]!, 4);
    },
  );

  it.each(
    [25, 26, 27, 28, 29, 30, 31, 32, 33].map((bar) => ({ bar })),
  )(
    "checkpoint at bar $bar with preserved buffer: signal seeds at bar 33," +
      " signalEma and hist match full recompute",
    ({ bar }) => {
      const closes = makeCloses(60);
      const { signal, hist } = macd(closes);

      // Checkpoint at `bar` with full buffer preserved (correct contract).
      const checkpoint = runIncrementalToBar(closes, bar);

      // For bars 25-32 the signal has not yet been seeded at the checkpoint.
      // For bar 33 runIncrementalToBar already processed the seeding bar.
      if (bar < 33) {
        expect(checkpoint.signalEma).toBeNull();

        // Feed bars (bar+1) through 32 — signal must remain null until bar 33.
        let state = checkpoint;
        for (let i = bar + 1; i <= 32; i++) {
          const upd = macdUpdate(state, closes[i]);
          state = upd;
          expect(upd.signalEma).toBeNull();
        }

        // Bar 33: seeding fires at the same bar as full recompute.
        const upd33 = macdUpdate(state, closes[33]);
        expect(upd33.signalEma).not.toBeNull();
        expect(upd33.hist).not.toBeNull();

        // Continue to bar 49 and assert parity with full recompute.
        state = upd33;
        let lastUpd = upd33;
        for (let i = 34; i <= 49; i++) {
          lastUpd = macdUpdate(state, closes[i]);
          state = lastUpd;
        }
        expect(lastUpd.signalEma).toBeCloseTo(signal[49]!, 4);
        expect(lastUpd.hist).toBeCloseTo(hist[49]!, 4);
      } else {
        // Bar 33 checkpoint: seeding already occurred inside runIncrementalToBar.
        expect(checkpoint.signalEma).not.toBeNull();

        // Continue from bar 34 to bar 49 and verify parity.
        let state: MacdIncrState = checkpoint;
        let lastUpd!: ReturnType<typeof macdUpdate>;
        for (let i = 34; i <= 49; i++) {
          lastUpd = macdUpdate(state, closes[i]);
          state = lastUpd;
        }
        expect(lastUpd.signalEma).toBeCloseTo(signal[49]!, 4);
        expect(lastUpd.hist).toBeCloseTo(hist[49]!, 4);
      }
    },
  );
});

describe("macd — single-bar-update parity", () => {
  const closes = makeCloses(200);

  it("incremental update matches full recompute at bar 100", () => {
    const { line, signal, hist } = macd(closes);

    // Build EMA state incrementally.
    // EMA(12) and EMA(26) seed at bar 11 and 25 respectively.
    // We'll replicate from bar 25 onward.
    const alpha12 = 2 / 13;
    const alpha26 = 2 / 27;

    // Seed EMA12 at bar 11 with SMA(12).
    let emaFast = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    for (let i = 12; i <= 25; i++) {
      emaFast = alpha12 * closes[i] + (1 - alpha12) * emaFast;
    }

    // Seed EMA26 at bar 25 with SMA(26).
    let emaSlow = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;

    // MACD line starts at bar 25.
    let macdLine0 = emaFast - emaSlow;

    // We need 9 MACD values to seed signal EMA at bar 33.
    // Collect macdLine values for bars 25..33.
    const macdSeedVals: number[] = [macdLine0];
    for (let i = 26; i <= 33; i++) {
      emaFast = alpha12 * closes[i] + (1 - alpha12) * emaFast;
      emaSlow = alpha26 * closes[i] + (1 - alpha26) * emaSlow;
      macdSeedVals.push(emaFast - emaSlow);
    }

    // Seed signal EMA with SMA of first 9 MACD values.
    let signalEma =
      macdSeedVals.slice(0, 9).reduce((a, b) => a + b, 0) / 9;

    // Update emaFast/emaSlow to match bar 33 state after seeding.
    // (they're already at bar 33 from the loop above)

    // Advance incrementally bar 34..100.
    let state: MacdIncrState = { emaFast, emaSlow, signalEma, macdValuesSinceSeed: [], signalSeedingActive: true };
    for (let i = 34; i <= 100; i++) {
      const upd = macdUpdate(state, closes[i]);
      state = upd;
    }
    const { emaFast: emaFastFinal, emaSlow: emaSlowFinal, signalEma: signalEmaFinal } = state;

    const incrMacdLine = emaFastFinal - emaSlowFinal;
    const incrSignal = signalEmaFinal;
    const incrHist = incrMacdLine - incrSignal!;

    expect(incrMacdLine).toBeCloseTo(line[100]!, 4);
    expect(incrSignal).toBeCloseTo(signal[100]!, 4);
    expect(incrHist).toBeCloseTo(hist[100]!, 4);
  });
});
