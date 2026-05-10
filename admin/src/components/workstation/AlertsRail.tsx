import { Badge } from "../ui/Badge";
import { SectionHeader } from "../ui/Section";

interface Alert {
  id: string;
  symbol: string;
  condition: string;
  kind: "price" | "indicator" | "volume";
}

/**
 * Mocked alerts for PR #2. Real alerts subsystem is not yet exposed by the
 * backend — this rail will hydrate from `/api/admin/alerts` once that endpoint
 * lands. Layout + interactions are final; only the data source is provisional.
 */
const MOCK_ALERTS: Alert[] = [
  { id: "1", symbol: "BTC", condition: "BTC > 69,200", kind: "price" },
  { id: "2", symbol: "ETH", condition: "ETH RSI < 30", kind: "indicator" },
  { id: "3", symbol: "SOL", condition: "SOL Vol > 2x", kind: "volume" },
];

const kindTone: Record<Alert["kind"], "brand" | "warn" | "neutral"> = {
  price: "brand",
  indicator: "warn",
  volume: "neutral",
};

const kindLabel: Record<Alert["kind"], string> = {
  price: "Price",
  indicator: "Indicator",
  volume: "Volume",
};

export function AlertsRail() {
  return (
    <div className="flex flex-col">
      <SectionHeader
        title="Active alerts"
        right={
          <button
            type="button"
            disabled
            className="text-2xs text-muted2 disabled:cursor-not-allowed disabled:opacity-50"
            title="Alerts management coming soon"
          >
            Manage
          </button>
        }
      />
      <ul className="divide-y divide-line">
        {MOCK_ALERTS.map((a) => (
          <li
            key={a.id}
            className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-sunken/60 transition-colors"
          >
            <span className="num text-xs text-ink2 truncate">{a.condition}</span>
            <Badge tone={kindTone[a.kind]} size="sm">
              {kindLabel[a.kind]}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
