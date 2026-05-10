import { useEffect, useState } from "react";

import { apiFetch } from "../lib/api";

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
      <span className="px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 text-[11px]">
        bullish{magStr}
      </span>
    );
  }
  if (label === "negative") {
    return (
      <span className="px-1.5 py-0.5 rounded bg-red-950 text-red-300 text-[11px]">
        bearish{magStr}
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[11px]">
      neutral{magStr}
    </span>
  );
}

function UsageCard({ usage }: { usage: NewsUsage }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4 mb-2">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
        LLM Usage{" "}
        <span className="font-normal normal-case text-slate-500">
          (today + last 24h, day-bucketed)
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xl font-semibold text-slate-100">
            {usage.articlesEnriched.toLocaleString()}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Articles enriched</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-slate-100">
            {(usage.totalInputTokens / 1000).toFixed(1)}k
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Input tokens</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-slate-100">
            {(usage.totalOutputTokens / 1000).toFixed(1)}k
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Output tokens</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-emerald-400">
            ${usage.estimatedCostUsd.toFixed(4)}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Est. cost (USD)</div>
        </div>
      </div>
      {Object.keys(usage.byModel).length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-800 flex flex-wrap gap-3">
          {Object.entries(usage.byModel).map(([model, stats]) => (
            <div key={model} className="text-[11px] text-slate-500">
              <span className="text-slate-400">{model}</span>
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
      <div className="p-3 rounded bg-red-950/40 text-red-300 border border-red-900 text-sm">
        {error}
      </div>
    );
  if (!data) return <div className="text-sm text-slate-500">Loading...</div>;

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
                ? "bg-indigo-600 border-indigo-500 text-white"
                : "bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-slate-500">
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
            <div key={id} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-sm text-slate-100 mb-1">{n.title ?? "(no title)"}</div>
              <div className="flex flex-wrap gap-2 text-[11px] items-center">
                <span className="text-slate-500">{n.source ?? "unknown"}</span>
                <span className="text-slate-600">·</span>
                <span className="text-slate-500">
                  {n.publishedAt ? new Date(n.publishedAt).toLocaleString() : ""}
                </span>

                <SentimentChip item={n} />

                <span
                  className={`px-1.5 py-0.5 rounded text-[11px] ${
                    n.status === "enriched"
                      ? "bg-slate-800 text-slate-300"
                      : n.status === "failed"
                        ? "bg-red-950 text-red-400"
                        : "bg-slate-800 text-slate-500"
                  }`}
                >
                  {n.status ?? "raw"}
                </span>

                {pairs.map((c) => (
                  <span key={c} className="px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300">
                    {c}
                  </span>
                ))}

                {hasEnrichment && (
                  <button
                    className="ml-auto text-slate-500 hover:text-slate-300 underline underline-offset-2"
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
              </div>

              {isExpanded && hasEnrichment && (
                <pre className="mt-2 p-2 rounded bg-slate-950 text-[10px] text-slate-400 overflow-x-auto whitespace-pre-wrap break-words">
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
            className="px-4 py-1.5 rounded border border-slate-700 text-sm text-slate-400 hover:border-slate-500 hover:text-slate-200 disabled:opacity-50 transition-colors"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        )}
        {atPageLimit && (
          <p className="text-[11px] text-slate-500">
            {MAX_PAGES} pages loaded. Reload the page to start over.
          </p>
        )}
        {pagesLoaded > 1 && (
          <p className="text-[11px] text-slate-600">
            {pagesLoaded} pages loaded &middot; {allNews.length} articles
          </p>
        )}
      </div>
    </div>
  );
}
