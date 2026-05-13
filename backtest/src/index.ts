/**
 * Public entrypoint for the quantara-backtest workspace.
 *
 * Re-exports the dependency-free cost estimator math so other workspaces
 * (backend, admin) can share the same constants and `computeEstimateMath()`
 * without pulling in the engine / DDB / ingestion deps. The full engine
 * remains accessible via deep paths but is intentionally NOT re-exported
 * here to keep bundle size honest for backend consumers.
 */

export {
  HAIKU_INPUT_PRICE_PER_M,
  HAIKU_OUTPUT_PRICE_PER_M,
  SONNET_INPUT_PRICE_PER_M,
  SONNET_OUTPUT_PRICE_PER_M,
  EST_INPUT_TOKENS_PER_CALL,
  EST_OUTPUT_TOKENS_PER_CALL,
  EST_LATENCY_MS_PER_CALL,
  DEFAULT_GATE_RATE,
  GATE_RATE_FLOOR,
  GATE_RATE_CEILING,
  TF_MS as ESTIMATOR_TF_MS,
  SIGNAL_TF_COUNT_MULTI_TF,
  computeEstimateMath,
  zeroEstimate,
} from "./cost/estimator-pure.js";

export type {
  RatificationCostEstimate,
  RatificationModel,
  ComputeEstimateInput,
} from "./cost/estimator-pure.js";

export { listStrategies, type StrategyMeta } from "./strategies-registry.js";
