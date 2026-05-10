import { useEffect, useState } from "react";
import { GLOSSARY } from "@quantara/shared";

import { apiFetch } from "../lib/api";
import { HelpTooltip } from "../components/HelpTooltip";

// ---------------------------------------------------------------------------
// Debug: preview enrichment result type
// ---------------------------------------------------------------------------
interface PreviewEnrichmentResult {
  newsId: string;
  title: string;
  storedEnrichment: Record<string, unknown> | null;
  previewedEnrichment: {
    mentionedPairs: string[];
    sentiment: { score: number; magnitude: number; model: string };
    enrichedAt: string;
    latencyMs: number;
    costUsd: number;
  };
  mutated: false;
}

// Active enrichment path (`ingestion/src/enrichment/bedrock.ts`) writes a
// string-union sentiment + per-event extraction. This is what most production
// records carry today.
interface NewsEnrichment {
  sentiment?: "bullish" | "bearish" | "neutral";
  confidence?: number;
  events?: string[];
  relevance?: Record<string, number>;
  timeHorizon?: string;
  summary?: string;
}

// Phase 5a path (`ingestion/src/news/enrich.ts`) writes a numeric
// `sentiment` object alongside `mentionedPairs`. Records may carry either
// or both shapes — the UI handles both.
interface Phase5aSentiment {
  score?: number; // -1 (bearish) … +1 (bullish)
  magnitude?: number; // 0 (weak) … 1 (strong claim)
  model?: string;
}

interface NewsItem {
  newsId?: string;
  title?: string;
  source?: string;
  publishedAt?: string;
  currencies?: string[];
  rawSentiment?: string;
  status?: string;
  /** Active path enrichment (string-union sentiment). */
  enrichment?: NewsEnrichment;
  /** Phase 5a sentiment object (score + magnitude); written separately when Phase 5a runs. */
  sentiment?: Phase5aSentiment;
  /** Phase 5a pair-tagging output. */
  mentionedPairs?: string[];
  enrichedAt?: string;
}

interface NewsData {
  news: NewsItem[];
  fearGreed: { value: number; classification: string } | null;
  nextCursor: string | null;
}

interface UsageByModel {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface NewsUsage {
  articlesEnriched: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  byModel: Record<string, UsageByModel>;
}

type SentimentFilter = "all" | "positive" | "negative" | "high-magnitude";

/**
 * Resolve the article's sentiment label from whichever enrichment shape is
 * present. Phase 5a's numeric `sentiment.score` takes precedence when set
 * (more accurate); falls back to the active path's string sentiment, then
 * to the source feed's rawSentiment.
 */
function sentimentLabel(item: NewsItem): "positive" | "negative" | "neutral" {
  const score = item.sentiment?.score;
  if (typeof score === "number") {
    if (score > 0.1) return "positive";
    if (score < -0.1) return "negative";
    return "neutral";
  }
  const s = item.enrichment?.sentiment ?? item.rawSentiment;
  if (s === "bullish" || s === "positive") return "positive";
  if (s === "bearish" || s === "negative") return "negative";
  return "neutral";
}

/**
 * Strength of the sentiment claim, in [0, 1]. Phase 5a's `sentiment.magnitude`
 * is the right field for this; the active path's `enrichment.confidence` is a
 * proxy (entity-extraction certainty, not sentiment intensity), used as a
 * fallback when magnitude isn't populated.
 */
function magnitudeValue(item: NewsItem): number {
  if (typeof item.sentiment?.magnitude === "number") return item.sentiment.magnitude;
  if (typeof item.enrichment?.confidence === "number") return item.enrichment.confidence;
  return 0;
}

function matchesFilter(item: NewsItem, filter: SentimentFilter): boolean {
  if (filter === "all") return true;
  if (filter === "positive") return sentimentLabel(item) === "positive";
  if (filter === "negative") return sentimentLabel(item) === "negative";
  if (filter === "high-magnitude") return magnitudeValue(item) >= 0.7;
  return true;
}

function SentimentChip({ item }: { item: NewsItem }) {
  const label = sentimentLabel(item);
  const magnitude = magnitudeValue(item);
  const magStr = magnitude > 0 ? ` ${Math.round(magnitude * 100)}%` : "";

  if (label === "positive") {
    return (
      <span className="px-1.5 py-0.5 rounded bg-up-soft text-up-strong text-[11px]">
        bullish{magStr}
      </span>
    );
  }
  if (label === "negative") {
    return (
      <span className="px-1.5 py-0.5 rounded bg-down-soft text-down-strong text-[11px]">
        bearish{magStr}
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded bg-sunken text-muted text-[11px]">neutral{magStr}</span>
  );
}

function UsageCard({ usage }: { usage: NewsUsage }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4 mb-2">
      <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
        LLM Usage{" "}
        <span className="font-normal normal-case text-muted2">
          (today + last 24h, day-bucketed)
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xl font-semibold text-ink">
            {usage.articlesEnriched.toLocaleString()}
          </div>
          <div className="text-[11px] text-muted2 mt-0.5">Articles enriched</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-ink">
            {(usage.totalInputTokens / 1000).toFixed(1)}k
          </div>
          <div className="text-[11px] text-muted2 mt-0.5">Input tokens</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-ink">
            {(usage.totalOutputTokens / 1000).toFixed(1)}k
          </div>
          <div className="text-[11px] text-muted2 mt-0.5">Output tokens</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-up">${usage.estimatedCostUsd.toFixed(4)}</div>
          <div className="text-[11px] text-muted2 mt-0.5">Est. cost (USD)</div>
        </div>
      </div>
      {Object.keys(usage.byModel).length > 0 && (
        <div className="mt-3 pt-3 border-t border-line flex flex-wrap gap-3">
          {Object.entries(usage.byModel).map(([model, stats]) => (
            <div key={model} className="text-[11px] text-muted2">
              <span className="text-muted">{model}</span>
              {" — "}
              {stats.calls.toLocaleString()} calls, ${stats.costUsd.toFixed(4)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MAX_PAGES = 10;

export function News() {
  // `pages` holds each loaded page of news items. Page 0 is the first page
  // (most recent), subsequent pages extend backward in time.
  const [pages, setPages] = useState<NewsItem[][]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [fearGreed, setFearGreed] = useState<NewsData["fearGreed"]>(null);
  const [usage, setUsage] = useState<NewsUsage | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<SentimentFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);

  // Derived flat list of all loaded news items (first page only refreshes via polling).
  const allNews = pages.flat();

  // Debug: preview enrichment state keyed by newsId
  const [previewResults, setPreviewResults] = useState<Record<string, PreviewEnrichmentResult>>({});
  const [previewLoading, setPreviewLoading] = useState<Set<string>>(new Set());
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});

  async function handlePreviewEnrichment(newsId: string) {
    if (!newsId) return;
    setPreviewLoading((prev) => new Set(prev).add(newsId));
    setPreviewErrors((prev) => {
      const n = { ...prev };
      delete n[newsId];
      return n;
    });
    const res = await apiFetch<PreviewEnrichmentResult>(
      "/api/admin/debug/preview-news-enrichment",
      {
        method: "POST",
        body: { newsId },
      },
    );
    setPreviewLoading((prev) => {
      const n = new Set(prev);
      n.delete(newsId);
      return n;
    });
    if (res.success && res.data) {
      setPreviewResults((prev) => ({ ...prev, [newsId]: res.data! }));
    } else {
      setPreviewErrors((prev) => ({
        ...prev,
        [newsId]: res.error?.message ?? "Preview enrichment failed",
      }));
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadFirstPage() {
      const [newsRes, usageRes] = await Promise.all([
        apiFetch<NewsData>("/api/admin/news?limit=50"),
        apiFetch<NewsUsage>("/api/admin/news/usage"),
      ]);
      if (cancelled) return;
      if (newsRes.success && newsRes.data) {
        // Replace only the first page on refresh — don't discard pages the
        // operator loaded via "Load more". If they've paginated, keep pages 1+.
        // Update `nextCursor` only when the operator has not paginated yet
        // (`prev.length <= 1`); otherwise the saved boundary may have shifted
        // because new articles arrived between the original page-0 fetch and
        // this poll, and applying the new cursor would cause duplicates or
        // gaps on the next "Load more". Once paginated, the cursor freezes
        // until the operator reloads.
        setPages((prev) => {
          if (prev.length <= 1) {
            setNextCursor(newsRes.data!.nextCursor);
          }
          return [newsRes.data!.news, ...prev.slice(1)];
        });
        setFearGreed(newsRes.data.fearGreed);
        setError("");
      } else {
        setError(newsRes.error?.message ?? "Failed to load");
      }
      if (usageRes.success && usageRes.data) {
        setUsage(usageRes.data);
      }
    }

    void loadFirstPage();
    // Only the first page polls — pagination is for "browse history" mode.
    const id = setInterval(loadFirstPage, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function loadMore() {
    if (!nextCursor || loadingMore || pages.length >= MAX_PAGES) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch<NewsData>(
        `/api/admin/news?limit=50&cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (res.success && res.data) {
        setPages((prev) => [...prev, res.data!.news]);
        setNextCursor(res.data.nextCursor);
        setError("");
      } else {
        // Surface the failure so repeat clicks aren't silently swallowed.
        // Leave `nextCursor` unchanged so a retry can try the same cursor.
        setError(res.error?.message ?? "Failed to load more news");
      }
    } catch (err) {
      // Network / fetch threw — same UX as a non-success response.
      setError((err as Error)?.message ?? "Failed to load more news");
    } finally {
      setLoadingMore(false);
    }
  }

  // Compatibility: expose a `data` shape for the JSX below to avoid rewriting the render tree.
  const data = pages.length > 0 ? { news: allNews, fearGreed } : null;

  if (error)
    return (
      <div className="p-3 rounded bg-down-soft text-down-strong border border-down/30 text-sm">
        {error}
      </div>
    );
  if (!data) return <div className="text-sm text-muted2">Loading...</div>;

  const filtered = data.news.filter((n) => matchesFilter(n, filter));
  const pagesLoaded = pages.length;
  const atPageLimit = pagesLoaded >= MAX_PAGES;

  const filterPills: { key: SentimentFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "positive", label: "Positive" },
    { key: "negative", label: "Negative" },
    { key: "high-magnitude", label: "High-magnitude" },
  ];

  return (
    <div className="space-y-3">
      {usage && <UsageCard usage={usage} />}

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2 items-center">
        {filterPills.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
              filter === key
                ? "bg-brand-strong border-brand text-white"
                : "bg-surface border-line text-muted hover:border-line-strong"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted2">
          {filtered.length} of {data.news.length}
        </span>
      </div>

      <div className="space-y-2">
        {filtered.map((n, i) => {
          const id = n.newsId ?? String(i);
          const isExpanded = expanded.has(id);
          // Surface the LLM pair-tagging output (Phase 5a) when present,
          // since that's what this page exists for. Fall back to
          // source-provided `currencies` for unenriched rows so the chip
          // strip isn't empty before enrichment runs.
          const pairs = n.mentionedPairs ?? n.currencies ?? [];
          const hasEnrichment = !!n.enrichment || !!n.sentiment;

          return (
            <div key={id} className="rounded-lg border border-line bg-surface p-3">
              <div className="text-sm text-ink mb-1">{n.title ?? "(no title)"}</div>
              <div className="flex flex-wrap gap-2 text-[11px] items-center">
                <span className="text-muted2">{n.source ?? "unknown"}</span>
                <span className="text-muted2">·</span>
                <span className="text-muted2">
                  {n.publishedAt ? new Date(n.publishedAt).toLocaleString() : ""}
                </span>

                <span className="inline-flex items-center gap-1">
                  <SentimentChip item={n} />
                  {/* Phase 5a tooltip — only when the numeric path ran */}
                  {typeof n.sentiment?.score === "number" && (
                    <HelpTooltip
                      label={GLOSSARY.phase5aSentiment.label}
                      code={GLOSSARY.phase5aSentiment.code}
                    >
                      {GLOSSARY.phase5aSentiment.body}
                    </HelpTooltip>
                  )}
                </span>

                <span
                  className={`px-1.5 py-0.5 rounded text-[11px] ${
                    n.status === "enriched"
                      ? "bg-sunken text-ink2"
                      : n.status === "failed"
                        ? "bg-down-soft text-down"
                        : "bg-sunken text-muted2"
                  }`}
                >
                  {n.status ?? "raw"}
                </span>
                {/* Status tooltip rendered once, outside the chip, so it's available regardless of status value */}
                <HelpTooltip label={GLOSSARY.newsStatus.label}>
                  {GLOSSARY.newsStatus.body}
                </HelpTooltip>

                {pairs.length > 0 && (
                  <span className="inline-flex items-center gap-1">
                    {pairs.map((c) => (
                      <span key={c} className="px-1.5 py-0.5 rounded bg-brand-soft text-brand">
                        {c}
                      </span>
                    ))}
                    <HelpTooltip label={GLOSSARY.mentionedPairs.label}>
                      {GLOSSARY.mentionedPairs.body}
                    </HelpTooltip>
                  </span>
                )}

                <div className="ml-auto flex items-center gap-2">
                  {hasEnrichment && (
                    <button
                      className="text-muted2 hover:text-ink2 underline underline-offset-2"
                      onClick={() => {
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        });
                      }}
                    >
                      {isExpanded ? "hide" : "detail"}
                    </button>
                  )}
                  {n.newsId && (
                    <button
                      className="text-brand hover:text-brand underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
                      disabled={previewLoading.has(id)}
                      onClick={() => handlePreviewEnrichment(id)}
                      title="Preview enrichment — re-runs Phase 5a in-memory against current prompts (read-only)"
                    >
                      {previewLoading.has(id) ? "running…" : "preview enrichment"}
                    </button>
                  )}
                </div>
              </div>

              {isExpanded && hasEnrichment && (
                <pre className="mt-2 p-2 rounded bg-paper text-[10px] text-muted overflow-x-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(
                    {
                      // Stringify a combined view so Phase 5a-only rows (which
                      // have `sentiment` / `mentionedPairs` but no `enrichment`)
                      // don't render as blank when expanded — `JSON.stringify`
                      // on an object containing `undefined` keys silently drops
                      // them, so each field appears only when populated.
                      enrichment: n.enrichment,
                      sentiment: n.sentiment,
                      mentionedPairs: n.mentionedPairs,
                      enrichedAt: n.enrichedAt,
                    },
                    null,
                    2,
                  )}
                </pre>
              )}

              {/* Preview enrichment result */}
              {previewErrors[id] && (
                <div className="mt-2 p-2 rounded bg-down-soft text-[11px] text-down">
                  {previewErrors[id]}
                </div>
              )}
              {previewResults[id] && (
                <div className="mt-2 space-y-1.5">
                  <div className="text-[10px] text-muted2 uppercase tracking-widest">
                    Preview result{" "}
                    <span className="normal-case font-normal text-muted2">
                      (not saved · {previewResults[id].previewedEnrichment.latencyMs}ms · $
                      {previewResults[id].previewedEnrichment.costUsd.toFixed(5)})
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {previewResults[id].previewedEnrichment.mentionedPairs.map((p) => (
                      <span
                        key={p}
                        className="px-1.5 py-0.5 rounded bg-brand-soft text-brand text-[11px]"
                      >
                        {p}
                      </span>
                    ))}
                    <span
                      className={`px-1.5 py-0.5 rounded text-[11px] ${
                        previewResults[id].previewedEnrichment.sentiment.score > 0.1
                          ? "bg-up-soft text-up-strong"
                          : previewResults[id].previewedEnrichment.sentiment.score < -0.1
                            ? "bg-down-soft text-down-strong"
                            : "bg-sunken text-muted"
                      }`}
                    >
                      score {previewResults[id].previewedEnrichment.sentiment.score.toFixed(2)} ·
                      mag {previewResults[id].previewedEnrichment.sentiment.magnitude.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Load more / pagination footer */}
      <div className="flex flex-col items-center gap-2 pt-1">
        {nextCursor && !atPageLimit && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="px-4 py-1.5 rounded border border-line text-sm text-muted hover:border-line-strong hover:text-ink disabled:opacity-50 transition-colors"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        )}
        {atPageLimit && (
          <p className="text-[11px] text-muted2">
            {MAX_PAGES} pages loaded. Reload the page to start over.
          </p>
        )}
        {pagesLoaded > 1 && (
          <p className="text-[11px] text-muted2">
            {pagesLoaded} pages loaded &middot; {allNews.length} articles
          </p>
        )}
      </div>
    </div>
  );
}
