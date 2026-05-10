import { Badge } from "../ui/Badge";
import { ChangePct, formatPrice, MonoNum } from "../ui/MonoNum";

import { AssetGlyph } from "./AssetGlyph";
import type { SymbolMeta } from "./symbols";

export type Timeframe = "15m" | "1H" | "4H" | "1D" | "1W";

export interface SymbolStats {
  price: number | null;
  change24hPct: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  fundingPct: number | null;
}

const TIMEFRAMES: Timeframe[] = ["15m", "1H", "4H", "1D", "1W"];

/** Map UI timeframe label → backend `?timeframe=` value the candles table understands. */
export const TIMEFRAME_TO_API: Record<Timeframe, string> = {
  "15m": "15m",
  "1H": "1h",
  "4H": "4h",
  "1D": "1d",
  "1W": "1w",
};

export function SymbolHeader({
  meta,
  stats,
  timeframe,
  onTimeframeChange,
}: {
  meta: SymbolMeta;
  stats: SymbolStats;
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
}) {
  return (
    <div className="px-5 py-4 border-b border-line">
      <div className="flex items-end justify-between gap-6 flex-wrap">
        <div className="flex items-center gap-3">
          <AssetGlyph meta={meta} size="lg" />
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-ink tracking-tight">{meta.symbol}/USD</h2>
              <Badge tone="outline" size="sm">
                Spot
              </Badge>
            </div>
            <div className="flex items-baseline gap-3 mt-1">
              <MonoNum className="text-3xl font-semibold text-ink">
                {formatPrice(stats.price)}
              </MonoNum>
              <ChangePct value={stats.change24hPct} digits={2} className="text-sm" />
            </div>
          </div>
        </div>

        <div className="flex items-end gap-5">
          <Stat label="24H High" value={formatPrice(stats.high24h)} />
          <Stat label="24H Low" value={formatPrice(stats.low24h)} />
          <Stat
            label="24H Vol"
            value={
              stats.volume24h === null
                ? "—"
                : stats.volume24h > 1e6
                  ? `${(stats.volume24h / 1e6).toFixed(2)}M`
                  : `${(stats.volume24h / 1e3).toFixed(2)}K`
            }
          />
          <Stat
            label="Funding"
            value={stats.fundingPct === null ? "—" : `${stats.fundingPct.toFixed(3)}%`}
          />
        </div>
      </div>

      <div className="flex items-center gap-1 mt-4">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            type="button"
            onClick={() => onTimeframeChange(tf)}
            className={`text-2xs uppercase tracking-widest px-2.5 py-1 rounded focus-ring transition-colors ${
              timeframe === tf ? "bg-sunken text-ink font-semibold" : "text-muted hover:text-ink2"
            }`}
          >
            {tf}
          </button>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-widest text-muted">{label}</div>
      <div className="num text-sm text-ink mt-0.5">{value}</div>
    </div>
  );
}
