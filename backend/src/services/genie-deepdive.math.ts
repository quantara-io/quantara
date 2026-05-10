/**
 * Pure computation functions for the Genie deep-dive analytics.
 * No DynamoDB imports — safe to unit test without AWS SDK mocks.
 */

// ---------------------------------------------------------------------------
// Types (re-exported so callers import from one place)
// ---------------------------------------------------------------------------

export interface CalibrationBin {
  binMin: number;
  binMax: number;
  signalCount: number;
  winRate: number;
  avgConfidence: number;
}

export interface PerRuleRow {
  rule: string;
  fireCount: number;
  tpRate: number;
  avgConfidence: number;
}

export interface CoOccurrenceRow {
  rules: [string, string];
  jointCount: number;
  tpRateWhenJoint: number;
}

export interface VolatilityBucket {
  atrPercentile: number; // lower bound of the quartile bucket (0, 25, 50, 75)
  signalCount: number;
  winRate: number;
}

export interface HourBucket {
  utcHour: number;
  signalCount: number;
  winRate: number;
}

// Internal shape — used by genie-deepdive.service.ts
export interface SignalRecord {
  pair: string;
  signalId: string;
  confidence: number;
  rulesFired: string[];
  closeTime: number;
  emittingTimeframe: string;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Build 10 bins of width 10% (0-10, 10-20, ..., 90-100).
 * Suppress bins with fewer than 10 directional signals (per spec).
 */
export function computeCalibration(
  signals: SignalRecord[],
  outcomeBySignalId: Map<string, "correct" | "incorrect" | "neutral">,
): CalibrationBin[] {
  const bins: { sum: number; wins: number; count: number }[] = Array.from({ length: 10 }, () => ({
    sum: 0,
    wins: 0,
    count: 0,
  }));

  for (const sig of signals) {
    const outcome = outcomeBySignalId.get(sig.signalId);
    // Only directional outcomes contribute to win-rate calibration.
    if (outcome !== "correct" && outcome !== "incorrect") continue;

    const idx = Math.min(Math.floor(sig.confidence * 10), 9);
    bins[idx].count++;
    bins[idx].sum += sig.confidence;
    if (outcome === "correct") bins[idx].wins++;
  }

  const result: CalibrationBin[] = [];
  for (let i = 0; i < 10; i++) {
    const b = bins[i];
    if (b.count < 10) continue; // suppress sparse bins
    result.push({
      binMin: i * 0.1,
      binMax: (i + 1) * 0.1,
      signalCount: b.count,
      winRate: b.wins / b.count,
      avgConfidence: b.sum / b.count,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-rule attribution
// ---------------------------------------------------------------------------

/**
 * For each rule, compute fire count, TP rate, and avg confidence
 * across all signals that include that rule in rulesFired.
 */
export function computePerRule(
  signals: SignalRecord[],
  outcomeBySignalId: Map<string, "correct" | "incorrect" | "neutral">,
): PerRuleRow[] {
  const ruleStats = new Map<
    string,
    { fireCount: number; wins: number; directional: number; confSum: number }
  >();

  for (const sig of signals) {
    const outcome = outcomeBySignalId.get(sig.signalId);
    for (const rule of sig.rulesFired) {
      if (!ruleStats.has(rule)) {
        ruleStats.set(rule, { fireCount: 0, wins: 0, directional: 0, confSum: 0 });
      }
      const stats = ruleStats.get(rule)!;
      stats.fireCount++;
      stats.confSum += sig.confidence;
      if (outcome === "correct" || outcome === "incorrect") {
        stats.directional++;
        if (outcome === "correct") stats.wins++;
      }
    }
  }

  return Array.from(ruleStats.entries())
    .map(([rule, s]) => ({
      rule,
      fireCount: s.fireCount,
      tpRate: s.directional > 0 ? s.wins / s.directional : 0,
      avgConfidence: s.fireCount > 0 ? s.confSum / s.fireCount : 0,
    }))
    .sort((a, b) => b.fireCount - a.fireCount);
}

/**
 * Pairwise co-occurrence: for each pair of rules that fire together on the
 * same signal, record joint count and TP rate when both fire.
 * Only includes pairs where jointCount >= 2 to keep output meaningful.
 */
export function computeCoOccurrence(
  signals: SignalRecord[],
  outcomeBySignalId: Map<string, "correct" | "incorrect" | "neutral">,
): CoOccurrenceRow[] {
  const pairStats = new Map<
    string,
    { rules: [string, string]; count: number; wins: number; directional: number }
  >();

  for (const sig of signals) {
    const rules = sig.rulesFired;
    if (rules.length < 2) continue;
    const outcome = outcomeBySignalId.get(sig.signalId);

    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        // Canonical key: sort to avoid duplicating (A,B) and (B,A).
        const [a, b] = [rules[i], rules[j]].sort() as [string, string];
        const key = `${a}|${b}`;
        if (!pairStats.has(key)) {
          pairStats.set(key, { rules: [a, b], count: 0, wins: 0, directional: 0 });
        }
        const ps = pairStats.get(key)!;
        ps.count++;
        if (outcome === "correct" || outcome === "incorrect") {
          ps.directional++;
          if (outcome === "correct") ps.wins++;
        }
      }
    }
  }

  return Array.from(pairStats.values())
    .filter((ps) => ps.count >= 2)
    .map((ps) => ({
      rules: ps.rules,
      jointCount: ps.count,
      tpRateWhenJoint: ps.directional > 0 ? ps.wins / ps.directional : 0,
    }))
    .sort((a, b) => b.jointCount - a.jointCount);
}

// ---------------------------------------------------------------------------
// Regime computation
// ---------------------------------------------------------------------------

/**
 * Bucket signals by ATR percentile quartile.
 * atrPercentile values: 0 (0-25th), 25 (25-50th), 50 (50-75th), 75 (75-100th).
 */
export function computeByVolatility(
  signals: SignalRecord[],
  outcomeBySignalId: Map<string, "correct" | "incorrect" | "neutral">,
  atrMap: Map<string, number | null>,
): VolatilityBucket[] {
  // Collect all known ATR values to compute percentile thresholds.
  const atrValues: number[] = [];
  for (const sig of signals) {
    const key = `${sig.pair}#${sig.emittingTimeframe}#${sig.closeTime}`;
    const atr = atrMap.get(key);
    if (typeof atr === "number") atrValues.push(atr);
  }

  if (atrValues.length === 0) return [];

  atrValues.sort((a, b) => a - b);
  // Nearest-rank percentile: for p% of n samples, return the value at index
  // ceil(p/100 * n) - 1. Floor(p/100 * n) is off-by-one (e.g. n=4, p=25 →
  // index 1 instead of 0), shifting quartile boundaries.
  const pct = (p: number) => {
    const n = atrValues.length;
    const idx = Math.max(0, Math.ceil((p / 100) * n) - 1);
    return atrValues[Math.min(idx, n - 1)];
  };
  const q25 = pct(25);
  const q50 = pct(50);
  const q75 = pct(75);

  const buckets = [0, 25, 50, 75].map((q) => ({
    atrPercentile: q,
    wins: 0,
    directional: 0,
    count: 0,
  }));

  for (const sig of signals) {
    const key = `${sig.pair}#${sig.emittingTimeframe}#${sig.closeTime}`;
    const atr = atrMap.get(key);
    if (typeof atr !== "number") continue;

    // <= so that values exactly equal to a percentile cutoff land in the
    // "lower" bucket. This pairs with the nearest-rank percentile helper to
    // give the intended 0-25 / 25-50 / 50-75 / 75-100 bucket distribution.
    const bucketIdx = atr <= q25 ? 0 : atr <= q50 ? 1 : atr <= q75 ? 2 : 3;
    const outcome = outcomeBySignalId.get(sig.signalId);
    buckets[bucketIdx].count++;
    if (outcome === "correct" || outcome === "incorrect") {
      buckets[bucketIdx].directional++;
      if (outcome === "correct") buckets[bucketIdx].wins++;
    }
  }

  return buckets
    .filter((b) => b.count > 0)
    .map((b) => ({
      atrPercentile: b.atrPercentile,
      signalCount: b.count,
      winRate: b.directional > 0 ? b.wins / b.directional : 0,
    }));
}

/**
 * Bucket signals by UTC hour of closeTime. Produces 0-23 buckets (only
 * buckets with at least 1 signal are returned).
 */
export function computeByHour(
  signals: SignalRecord[],
  outcomeBySignalId: Map<string, "correct" | "incorrect" | "neutral">,
): HourBucket[] {
  const buckets: { wins: number; directional: number; count: number }[] = Array.from(
    { length: 24 },
    () => ({ wins: 0, directional: 0, count: 0 }),
  );

  for (const sig of signals) {
    const hour = new Date(sig.closeTime).getUTCHours();
    const outcome = outcomeBySignalId.get(sig.signalId);
    buckets[hour].count++;
    if (outcome === "correct" || outcome === "incorrect") {
      buckets[hour].directional++;
      if (outcome === "correct") buckets[hour].wins++;
    }
  }

  return buckets
    .map((b, h) => ({
      utcHour: h,
      signalCount: b.count,
      winRate: b.directional > 0 ? b.wins / b.directional : 0,
    }))
    .filter((b) => b.signalCount > 0);
}
