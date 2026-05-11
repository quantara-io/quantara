import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ChangePct, MonoNum, formatPrice } from "../ui/MonoNum";
import { SectionHeader } from "../ui/Section";

import { MOCK_POSITION } from "./mock-data";
import { metaForPair } from "./symbols";

/**
 * Mocked position card for PR #2. Quantara backend doesn't expose position
 * data yet — this is a faithful render of the design with synthetic values
 * so the layout, alignments, and interactions are visible. When a real
 * `/api/admin/positions/:pair` endpoint lands this component swaps in the
 * fetch with no markup change. Source of truth lives in `./mock-data.ts`.
 *
 * Issue #331: `onClose` wires the Close button to the real backend endpoint
 * via Workstation's `closePosition` handler. When `closed` is true the rail
 * shows a "Position closed" placeholder instead of the position card.
 */

export function PositionRail({
  activePair,
  onClose,
  closed = false,
}: {
  activePair: string;
  /** Called when the user confirms Close. Resolves after backend round-trip. */
  onClose?: () => Promise<void>;
  /** When true, renders a "Position closed" placeholder instead of the card. */
  closed?: boolean;
}) {
  const meta = metaForPair(activePair);
  const pos = MOCK_POSITION;

  if (closed) {
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
        />
        <div className="px-4 py-6 text-sm text-muted2 text-center">Position closed.</div>
      </div>
    );
  }

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
        <Button
          variant="primary"
          size="md"
          className="flex-1"
          disabled={!onClose}
          onClick={onClose}
        >
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
