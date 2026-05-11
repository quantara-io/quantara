/**
 * calibration-job.ts — EventBridge-triggered Lambda (daily @ 04:00 UTC).
 *
 * Phase 8/7 calibration coefficients job:
 *   For each (pair, TF) slice with n ≥ 50 resolved directional signals:
 *     1. Fit Platt scaling coefficients (a, b) via Newton-Raphson on raw confidence.
 *     2. Compute Kelly stats {p, b} per direction (buy / sell).
 *     3. Persist to the calibration-params DynamoDB table.
 *
 * The job writes nothing when no slice reaches the n ≥ 50 threshold — safe to
 * run before sufficient outcomes accumulate (see "Calendar dependency" in issue #308).
 */

import { PAIRS } from "@quantara/shared";
import { queryOutcomesByPairTimeframe } from "./lib/outcome-store.js";
import { fitPlattCoeffs, computeKellyStats } from "./calibration/math.js";
import { putPlattRow, putKellyRow } from "./calibration/calibration-store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeframes that emit blended signals (mirrors indicator-handler.ts). */
const SIGNAL_TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;

/** Look-back horizon for reading outcomes — use 90d (longest aggregate window). */
const LOOKBACK_DAYS = 90;

// ---------------------------------------------------------------------------
// EventBridge event type (used by scheduled cron)
// ---------------------------------------------------------------------------

interface ScheduledEvent {
  source?: string;
  "detail-type"?: string;
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(_event: ScheduledEvent): Promise<void> {
  const now = new Date().toISOString();
  console.log(`[CalibrationJob] Starting calibration run at ${now}`);

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400 * 1000).toISOString();

  let plattFitted = 0;
  let kellyFitted = 0;

  for (const pair of PAIRS) {
    for (const tf of SIGNAL_TIMEFRAMES) {
      try {
        const outcomes = await queryOutcomesByPairTimeframe(pair, tf, since);

        // --- Platt scaling -------------------------------------------------
        const plattCoeffs = fitPlattCoeffs(outcomes);
        if (plattCoeffs !== null) {
          await putPlattRow(pair, tf, plattCoeffs, now);
          plattFitted++;
          console.log(
            `[CalibrationJob] Platt fitted for ${pair}/${tf}: a=${plattCoeffs.a.toFixed(4)} b=${plattCoeffs.b.toFixed(4)} n=${plattCoeffs.n} ECE ${plattCoeffs.eceBefore.toFixed(4)} → ${plattCoeffs.eceAfter.toFixed(4)}`,
          );
        } else {
          // fitPlattCoeffs returns null for two reasons:
          //   1. fewer than CALIBRATION_MIN_SAMPLES directional outcomes, or
          //   2. Newton-Raphson produced non-finite (a, b) on degenerate data.
          // In either case we skip persistence — never write NaN/Infinity rows.
          console.log(
            `[CalibrationJob] Platt skipped for ${pair}/${tf} — insufficient samples or non-finite fit`,
          );
        }

        // --- Kelly stats ---------------------------------------------------
        for (const direction of ["buy", "sell"] as const) {
          const kellyStats = computeKellyStats(outcomes, direction);
          if (kellyStats !== null) {
            await putKellyRow(pair, tf, direction, kellyStats, now);
            kellyFitted++;
            console.log(
              `[CalibrationJob] Kelly fitted for ${pair}/${tf}/${direction}: p=${kellyStats.p.toFixed(4)} b=${kellyStats.b.toFixed(4)} n=${kellyStats.resolved}`,
            );
          } else {
            console.log(
              `[CalibrationJob] Kelly skipped for ${pair}/${tf}/${direction} — insufficient samples`,
            );
          }
        }
      } catch (err) {
        console.error(`[CalibrationJob] Error processing ${pair}/${tf}: ${(err as Error).message}`);
        // Continue processing remaining slices.
      }
    }
  }

  console.log(
    `[CalibrationJob] Done. Platt rows written: ${plattFitted}. Kelly rows written: ${kellyFitted}.`,
  );
}
