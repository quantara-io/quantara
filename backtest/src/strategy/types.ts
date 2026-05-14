/**
 * Strategy interface — Phase 2.
 *
 * A Strategy is a TypeScript module's default export that drives
 * the backtest engine: which rules to enable, per-TF weight overrides,
 * ratification thresholds, exit policy, and position sizing.
 *
 * Strategies are loaded via dynamic import() from a CLI-supplied file path.
 * The loaded export is validated with the strategySchema zod schema — an
 * invalid shape produces a human-readable error before the run starts.
 */

import { z } from "zod";
import type { Timeframe } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const exitPolicySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("n-bars"),
    nBars: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("atr-multiple"),
    atrMultiple: z.number().positive(),
  }),
  z.object({
    kind: z.literal("trailing-stop"),
    trailPct: z.number().positive(),
  }),
]);

const sizingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fixed-pct"),
    pct: z.number().positive(),
  }),
  z.object({
    kind: z.literal("kelly"),
    kellyFraction: z.number().positive(),
  }),
  z.object({
    kind: z.literal("vol-target"),
    volTarget: z.number().positive(),
  }),
]);

const calibrationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("frozen"), paramsAt: z.string() }),
  z.object({ kind: z.literal("walk-forward"), refitDays: z.number().int().positive() }),
]);

/**
 * Zod schema for the Strategy interface.
 * Used to validate dynamic imports from user-supplied strategy files.
 */
export const strategySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  enabledRules: z.array(z.string()).optional(),
  timeframeWeights: z
    .object({
      "1m": z.number().optional(),
      "5m": z.number().optional(),
      "15m": z.number().optional(),
      "1h": z.number().optional(),
      "4h": z.number().optional(),
      "1d": z.number().optional(),
    })
    .optional(),
  ratificationThreshold: z.number().min(0).max(1).optional(),
  exitPolicy: exitPolicySchema,
  sizing: sizingSchema,
  calibration: calibrationSchema.optional(),
});

// ---------------------------------------------------------------------------
// TypeScript interface (inferred from schema)
// ---------------------------------------------------------------------------

/**
 * Rule identifier — the `name` field of a Rule in @quantara/shared RULES array.
 * Typed as `string` rather than a union to avoid tight coupling to the rule list.
 */
export type RuleId = string;

export type Strategy = z.infer<typeof strategySchema> & {
  /** Partial override: only the specified TFs are overridden; others use DEFAULT_TIMEFRAME_WEIGHTS. */
  timeframeWeights?: Partial<Record<Timeframe, number>>;
  /**
   * Optional emission gate hook.
   *
   * Called right before the engine emits a signal, with the set of rule names
   * that fired for the candidate bar. Return "emit" to allow the signal through,
   * or "suppress" to discard it entirely (no signal is recorded for that bar).
   *
   * When absent, the engine preserves existing behavior — every bar that scores
   * above the confluence threshold is emitted without any additional filtering.
   *
   * Functions cannot be serialized and are therefore not part of the Zod schema;
   * the loader assigns them as a post-parse augmentation when present in the
   * module export.
   */
  emissionGate?: (rulesFired: Set<RuleId>) => "emit" | "suppress";
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate a strategy from an absolute file path.
 *
 * The file must export a `default` export that matches the Strategy interface.
 * Throws a descriptive error if validation fails.
 */
export async function loadStrategy(filePath: string): Promise<Strategy> {
  let mod: unknown;
  try {
    mod = await import(filePath);
  } catch (err) {
    throw new Error(`Failed to import strategy from "${filePath}": ${(err as Error).message}`);
  }

  // Support both `export default` and `module.exports = {...}` shapes.
  const candidate = (mod as { default?: unknown }).default ?? mod;

  const result = strategySchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Strategy file "${filePath}" failed validation:\n${issues}`);
  }

  // Functions can't be encoded in the Zod schema — preserve emissionGate from
  // the raw module export when present.
  const parsed = result.data as Strategy;
  const raw = candidate as Record<string, unknown>;
  if (typeof raw["emissionGate"] === "function") {
    parsed.emissionGate = raw["emissionGate"] as Strategy["emissionGate"];
  }

  return parsed;
}
