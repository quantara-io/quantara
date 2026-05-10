import type { HTMLAttributes, ReactNode } from "react";

type Tone = "default" | "sunken" | "outline";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: Tone;
  padding?: "none" | "sm" | "md" | "lg";
}

const paddingMap = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
};

const toneMap: Record<Tone, string> = {
  default: "bg-surface border border-line",
  sunken: "bg-sunken border border-line",
  outline: "bg-transparent border border-line",
};

export function Card({
  tone = "default",
  padding = "md",
  className = "",
  children,
  ...rest
}: CardProps) {
  return (
    <div className={`rounded-md ${toneMap[tone]} ${paddingMap[padding]} ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 mb-3">
      <div className="min-w-0">
        <div className="text-2xs uppercase tracking-widest text-muted font-medium">{title}</div>
        {subtitle && <div className="text-xs text-muted2 mt-0.5">{subtitle}</div>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}
