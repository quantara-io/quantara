import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
}

interface MarketChartProps {
  candles: Candle[];
  height?: number;
}

function getCss(name: string): string {
  return `rgb(${getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
    .replace(/\s+/g, " ")})`;
}

function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += values[j];
      prev = sum / (i + 1);
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

export function MarketChart({ candles, height = 380 }: MarketChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ema20Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema50Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  // Build chart once on mount; recompute colors when the theme class changes.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: getCss("--ink2"),
        fontFamily: "Geist, ui-sans-serif, system-ui",
      },
      grid: {
        vertLines: { color: getCss("--line"), style: 0 },
        horzLines: { color: getCss("--line"), style: 0 },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: getCss("--line") },
      timeScale: { borderColor: getCss("--line"), timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;

    candleSeriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: getCss("--up"),
      downColor: getCss("--down"),
      borderUpColor: getCss("--up-strong"),
      borderDownColor: getCss("--down-strong"),
      wickUpColor: getCss("--up"),
      wickDownColor: getCss("--down"),
      priceLineColor: getCss("--ink2"),
    });

    ema20Ref.current = chart.addSeries(LineSeries, {
      color: getCss("--brand"),
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    ema50Ref.current = chart.addSeries(LineSeries, {
      color: getCss("--warn"),
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    volumeSeriesRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      ema20Ref.current = null;
      ema50Ref.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // React to theme toggling via a MutationObserver on <html class="dark">.
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const obs = new MutationObserver(() => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.applyOptions({
        layout: { textColor: getCss("--ink2") },
        grid: {
          vertLines: { color: getCss("--line") },
          horzLines: { color: getCss("--line") },
        },
        rightPriceScale: { borderColor: getCss("--line") },
        timeScale: { borderColor: getCss("--line") },
      });
      candleSeriesRef.current?.applyOptions({
        upColor: getCss("--up"),
        downColor: getCss("--down"),
        borderUpColor: getCss("--up-strong"),
        borderDownColor: getCss("--down-strong"),
        wickUpColor: getCss("--up"),
        wickDownColor: getCss("--down"),
      });
      ema20Ref.current?.applyOptions({ color: getCss("--brand") });
      ema50Ref.current?.applyOptions({ color: getCss("--warn") });
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  // Push data whenever candles change.
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const ema20Series = ema20Ref.current;
    const ema50Series = ema50Ref.current;
    const volSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !ema20Series || !ema50Series || !volSeries || !chart) return;
    if (!candles || candles.length === 0) return;

    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    const dedupedMap = new Map<number, Candle>();
    for (const c of sorted) dedupedMap.set(Math.floor(c.openTime / 1000), c);
    const deduped = Array.from(dedupedMap.entries()).sort((a, b) => a[0] - b[0]);

    const candleData: CandlestickData<Time>[] = deduped.map(([t, c]) => ({
      time: t as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    const closes = deduped.map(([, c]) => c.close);
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);

    const ema20Data: LineData<Time>[] = [];
    const ema50Data: LineData<Time>[] = [];
    for (let i = 0; i < deduped.length; i++) {
      const t = deduped[i][0] as UTCTimestamp;
      if (ema20[i] !== null) ema20Data.push({ time: t, value: ema20[i] as number });
      if (ema50[i] !== null) ema50Data.push({ time: t, value: ema50[i] as number });
    }

    const upColor = getCss("--up");
    const downColor = getCss("--down");
    const volData: HistogramData<Time>[] = deduped.map(([t, c]) => ({
      time: t as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? upColor : downColor,
    }));

    candleSeries.setData(candleData);
    ema20Series.setData(ema20Data);
    ema50Series.setData(ema50Data);
    volSeries.setData(volData);
    chart.timeScale().fitContent();
  }, [candles]);

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height }} className="w-full" />
      <Legend />
    </div>
  );
}

function Legend() {
  return (
    <div className="absolute bottom-2 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted2 pointer-events-none">
      <LegendDot color="bg-brand" />
      <span>EMA 20</span>
      <LegendDot color="bg-warn" />
      <span>EMA 50</span>
      <LegendDot color="bg-up" />
      <span>Volume up</span>
      <LegendDot color="bg-down" />
      <span>Volume down</span>
    </div>
  );
}

function LegendDot({ color }: { color: string }) {
  return <span className={`inline-block w-2 h-2 rounded-sm ${color}`} aria-hidden="true" />;
}
