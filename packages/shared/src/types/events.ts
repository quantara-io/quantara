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
      signalType: "buy" | "sell" | "hold";
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
    };
