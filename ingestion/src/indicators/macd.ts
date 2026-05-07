import { ema } from "./helpers.js";

export interface MacdSeries {
  line: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
}

/**
 * MACD(12, 26, 9)
 *
 * macdLine = EMA(close, 12) - EMA(close, 26)
 * signal   = EMA(macdLine, 9)
 * histogram = macdLine - signal
 *
 * Warm-up: macdLine is null for bars 0..24 (needs 26-bar EMA).
 *          signal is null for an additional 8 bars after macdLine starts.
 * All series are aligned to close length.
 */
export function macd(
  close: number[],
  fastN = 12,
  slowN = 26,
  signalN = 9,
): MacdSeries {
  const len = close.length;
  const line: (number | null)[] = new Array(len).fill(null);
  const signal: (number | null)[] = new Array(len).fill(null);
  const hist: (number | null)[] = new Array(len).fill(null);

  const emaFast = ema(close, fastN);
  const emaSlow = ema(close, slowN);

  // Build the MACD line where both EMAs are non-null.
  const macdValues: (number | null)[] = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f !== null && s !== null) {
      macdValues[i] = f - s;
      line[i] = f - s;
    }
  }

  // Compute signal as EMA(9) of the MACD line values.
  // Extract non-null MACD values with their original indices.
  const firstMacdIdx = macdValues.findIndex((v) => v !== null);
  if (firstMacdIdx === -1) return { line, signal, hist };

  // Build a compact array of MACD values starting from firstMacdIdx.
  const macdCompact = macdValues.slice(firstMacdIdx) as number[];
  // There should be no nulls after firstMacdIdx if EMA(26) is seeded correctly.
  const signalCompact = ema(macdCompact, signalN);

  // Map back to the full-length array.
  for (let i = 0; i < signalCompact.length; i++) {
    const sv = signalCompact[i];
    const lv = line[firstMacdIdx + i];
    signal[firstMacdIdx + i] = sv;
    if (sv !== null && lv !== null) {
      hist[firstMacdIdx + i] = lv - sv;
    }
  }

  return { line, signal, hist };
}

/**
 * State passed to and returned from macdUpdate.
 *
 * Checkpoint / persistence contract (Phase 4):
 *   Persist ALL fields to DDB at each candle close and reload them as-is.
 *   In particular, macdValuesSinceSeed MUST be persisted and restored — do
 *   not reset it to [] on reload. Discarding the buffer during warm-up
 *   (signalEma === null) causes delayed and incorrect signal seeding.
 *
 *   Exception — initial state only: when bootstrapping for the very first
 *   time at bar 25 (the first bar where EMA12 and EMA26 are both defined),
 *   the buffer may be left as [] because macdUpdate will self-correct by
 *   reconstructing the implicit macdLine from (emaFast − emaSlow).
 */
export interface MacdIncrState {
  emaFast: number;
  emaSlow: number;
  /** null until signalN macd values have been accumulated */
  signalEma: number | null;
  /**
   * Buffer used only during cold-start (signalEma === null).
   * Accumulates macdLine values until there are enough to seed the signal EMA.
   * Once signalEma is seeded this array is always empty.
   *
   * Must be persisted and restored intact across checkpoints. Only omit (set
   * to []) when creating the initial state at bar 25 — macdUpdate will
   * self-correct by recovering the implicit macdLine from emaFast − emaSlow.
   */
  macdValuesSinceSeed: number[];
}

/**
 * Incremental MACD update.
 *
 * Cold-start behaviour (signalEma === null):
 *   Appends the new macdLine to macdValuesSinceSeed. Once the buffer reaches
 *   signalN values, seeds signalEma = SMA(buffer) and clears the buffer.
 *   Until seeded, signalEma and hist are null in the returned state.
 *
 *   Self-correction: if macdValuesSinceSeed is empty and signalEma is null
 *   (state was initialised or reloaded without the buffer), macdUpdate
 *   reconstructs the implicit macdLine for the checkpoint bar from
 *   (prev.emaFast − prev.emaSlow) and seeds the buffer with it before
 *   pushing the current bar's macdLine. This keeps signal seeding on-track
 *   when callers bootstrap a fresh state at bar 25 with an empty buffer.
 *   For checkpoints taken at bars 26-33, the full buffer must be persisted
 *   and restored — see MacdIncrState.macdValuesSinceSeed.
 *
 * Steady-state behaviour (signalEma !== null):
 *   Standard EMA update; macdValuesSinceSeed is kept as [].
 */
export function macdUpdate(
  prev: MacdIncrState,
  newClose: number,
  fastN = 12,
  slowN = 26,
  signalN = 9,
): MacdIncrState & { macdLine: number; hist: number | null } {
  const alphaFast = 2 / (fastN + 1);
  const alphaSlow = 2 / (slowN + 1);
  const alphaSignal = 2 / (signalN + 1);

  const emaFastNew = alphaFast * newClose + (1 - alphaFast) * prev.emaFast;
  const emaSlowNew = alphaSlow * newClose + (1 - alphaSlow) * prev.emaSlow;
  const macdLine = emaFastNew - emaSlowNew;

  let signalEma: number | null;
  let macdValuesSinceSeed: number[];
  let histVal: number | null = null;

  if (prev.signalEma !== null) {
    // Steady-state: normal EMA tick.
    signalEma = alphaSignal * macdLine + (1 - alphaSignal) * prev.signalEma;
    histVal = macdLine - signalEma;
    macdValuesSinceSeed = [];
  } else {
    // Cold-start: accumulate until we have enough values to seed.
    //
    // Self-correction for mid-warm-up checkpoints: if the buffer is empty but
    // both EMAs are already seeded (ema26 has fired), the state represents a
    // bar for which a macdLine value is implicit in (emaFast − emaSlow). A
    // checkpoint saved at that bar and reloaded with macdValuesSinceSeed: []
    // would otherwise skip that bar's contribution and delay signal seeding.
    // Restoring the implicit value here makes the helper correct regardless of
    // whether the caller persisted the buffer or cleared it on reload.
    const priorBuffer =
      prev.macdValuesSinceSeed.length === 0
        ? [prev.emaFast - prev.emaSlow]
        : [...prev.macdValuesSinceSeed];
    const buffer = [...priorBuffer, macdLine];
    if (buffer.length >= signalN) {
      // Seed signal EMA as SMA of the first signalN macd values.
      signalEma = buffer.slice(0, signalN).reduce((a, b) => a + b, 0) / signalN;
      // Apply EMA ticks for any values beyond the seed window.
      for (let i = signalN; i < buffer.length; i++) {
        signalEma = alphaSignal * buffer[i] + (1 - alphaSignal) * signalEma;
      }
      histVal = macdLine - signalEma;
      macdValuesSinceSeed = [];
    } else {
      signalEma = null;
      macdValuesSinceSeed = buffer;
    }
  }

  return {
    emaFast: emaFastNew,
    emaSlow: emaSlowNew,
    macdLine,
    signalEma,
    hist: histVal,
    macdValuesSinceSeed,
  };
}
