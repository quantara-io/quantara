import type { ReactNode } from "react";

interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "up" | "down" | "warn" | "brand";
  align?: "left" | "right";
}

const toneMap = {
  default: "text-ink",
  up: "text-up",
  down: "text-down",
  warn: "text-warn",
  brand: "text-brand",
};

export function StatTile({
  label,
  value,
  sub,
  tone = "default",
  align = "left",
}: StatTileProps) {
  return (
    <div
      className={`rounded-md border border-line bg-surface px-4 py-3 ${
        align === "right" ? "text-right" : ""
      }`}
    >
      <div className="text-2xs uppercase tracking-widest text-muted font-medium">{label}</div>
      <div className={`num text-xl font-semibold mt-1 ${toneMap[tone]}`}>{value}</div>
      {sub && <div className="text-xs text-muted2 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}
