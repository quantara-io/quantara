/**
 * PipelineEvent discriminated union — used by the pipeline activity feed.
 *
 * Each producer (indicator-handler, ratify, enrich) emits one of these
 * event shapes to the `pipeline-events` DDB table. The events-fanout
 * Lambda reads the DDB stream and pushes to WebSocket clients subscribed
 * to `?channel=events`.
 *
 * Sizes are kept small (< 500 bytes each) per the activity-feed spec.
 */
export type PipelineEvent =
  | {
      type: "indicator-state-updated";
      pair: string;
      timeframe: string;
      barsSinceStart: number;
      rsi14?: number;
      ts: string;
    }
  | {
      type: "signal-emitted";
      pair: string;
      timeframe: string;
      /** Signal type. Expanded to 5 tiers in v2 Phase 2 (#253). Old rows have "buy" | "sell" | "hold". */
      signalType: "strong-buy" | "buy" | "hold" | "sell" | "strong-sell";
      confidence: number;
      closeTime: string;
      ts: string;
    }
  | {
      type: "ratification-fired";
      pair: string;
      timeframe: string;
      triggerReason: string;
      verdict: "ratified" | "downgraded" | "not-required";
      latencyMs: number;
      costUsd: number;
      cacheHit: boolean;
      ts: string;
    }
  | {
      type: "news-enriched";
      newsId: string;
      mentionedPairs: string[];
      sentimentScore: number;
      sentimentMagnitude: number;
      ts: string;
    }
  | {
      type: "sentiment-shock-detected";
      pair: string;
      deltaScore: number;
      ts: string;
    }
  | {
      type: "quorum-failed";
      pair: string;
      timeframe: string;
      closeTime: string;
      ts: string;
    }
  // Backtest lifecycle events — Phase 4 (issue #371).
  // Emitted by the admin POST /admin/backtest route (queued) and the Fargate
  // backtest-runner (started / progress / completed / failed). The activity
  // feed renders these alongside production signal events so the operator
  // sees the runner heartbeat without tailing CloudWatch.
  | {
      type: "backtest-queued";
      runId: string;
      strategy: string;
      pair: string;
      timeframe: string;
      estimatedCostUsd: number;
      ts: string;
    }
  | {
      type: "backtest-started";
      runId: string;
      strategy: string;
      pair: string;
      timeframe: string;
      ts: string;
    }
  | {
      type: "backtest-progress";
      runId: string;
      /** 0..1 — fraction of the eval window processed. */
      progress: number;
      ts: string;
    }
  | {
      type: "backtest-completed";
      runId: string;
      strategy: string;
      pair: string;
      timeframe: string;
      durationMs: number;
      actualCostUsd: number;
      totalSignals: number;
      ts: string;
    }
  | {
      type: "backtest-failed";
      runId: string;
      strategy: string;
      pair: string;
      timeframe: string;
      reason: string;
      ts: string;
    };
