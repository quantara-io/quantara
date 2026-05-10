import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ChangePct, MonoNum, formatPrice } from "../ui/MonoNum";
import { SectionHeader } from "../ui/Section";

import { metaForPair } from "./symbols";

/**
 * Mocked position card for PR #2. Quantara backend doesn't expose position
 * data yet — this is a faithful render of the design with synthetic values
 * so the layout, alignments, and interactions are visible. When a real
 * `/api/admin/positions/:pair` endpoint lands this component swaps in the
 * fetch with no markup change.
 */
const MOCK_POSITION = {
  size: 8.42,
  entry: 69_568,
  mark: 71_092,
  pnl: 1_858.74,
  pnlPct: 2.61,
  side: "long" as const,
};

export function PositionRail({ activePair }: { activePair: string }) {
  const meta = metaForPair(activePair);
  const pos = MOCK_POSITION;

  return (
    <div className="flex flex-col">
      <SectionHeader
        title={
          <span>
            Position ·{" "}
            <span className="text-ink2 font-semibold normal-case tracking-normal">
              {meta.symbol}
            </span>
          </span>
        }
        right={
          <Badge tone={pos.side === "long" ? "up" : "down"} size="sm">
            {pos.side}
          </Badge>
        }
      />
      <div className="px-4 py-3 grid grid-cols-2 gap-3">
        <Cell label="Size" value={`${pos.size.toFixed(2)} ${meta.symbol}`} />
        <Cell label="Entry" value={formatPrice(pos.entry)} align="right" />
        <Cell label="Mark" value={formatPrice(pos.mark)} />
        <Cell
          label="P&L"
          align="right"
          value={
            <span className="flex flex-col items-end">
              <MonoNum className="text-up font-semibold">+${pos.pnl.toLocaleString()}</MonoNum>
              <ChangePct value={pos.pnlPct} className="text-2xs" />
            </span>
          }
        />
      </div>
      <div className="px-4 pb-4 pt-1 flex gap-2">
        <Button variant="primary" size="md" className="flex-1" disabled>
          Close
        </Button>
        <Button variant="secondary" size="md" className="flex-1" disabled>
          Adjust
        </Button>
      </div>
      <div className="px-4 pb-3 text-2xs text-muted2">Mocked — live trading not enabled.</div>
    </div>
  );
}

function Cell({
  label,
  value,
  align = "left",
}: {
  label: string;
  value: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className={align === "right" ? "text-right" : ""}>
      <div className="text-2xs uppercase tracking-widest text-muted">{label}</div>
      <div className="num text-sm text-ink mt-0.5">{value}</div>
    </div>
  );
}
