import type { ReactNode } from "react";

type Tone = "neutral" | "brand" | "up" | "down" | "warn" | "outline";
type Size = "sm" | "md";

const toneMap: Record<Tone, string> = {
  neutral: "bg-sunken text-ink2 border border-line",
  brand: "bg-brand-soft text-brand-strong border border-brand/20",
  up: "bg-up-soft text-up-strong border border-up/20",
  down: "bg-down-soft text-down-strong border border-down/20",
  warn: "bg-warn-soft text-warn border border-warn/20",
  outline: "bg-transparent text-ink2 border border-line",
};

const sizeMap: Record<Size, string> = {
  sm: "text-2xs px-1.5 py-0.5",
  md: "text-xs px-2 py-0.5",
};

export function Badge({
  tone = "neutral",
  size = "sm",
  children,
  className = "",
}: {
  tone?: Tone;
  size?: Size;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-medium uppercase tracking-wider ${toneMap[tone]} ${sizeMap[size]} ${className}`}
    >
      {children}
    </span>
  );
}
