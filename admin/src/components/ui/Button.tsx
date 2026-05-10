import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const variantMap: Record<Variant, string> = {
  primary:
    "bg-ink text-paper hover:bg-ink2 border border-ink disabled:bg-muted2 disabled:border-muted2",
  secondary: "bg-surface text-ink border border-line hover:bg-sunken disabled:opacity-50",
  ghost: "bg-transparent text-ink2 hover:text-ink hover:bg-sunken disabled:opacity-50",
  danger: "bg-down text-paper hover:bg-down-strong border border-down disabled:opacity-50",
};

const sizeMap: Record<Size, string> = {
  sm: "text-xs px-2.5 py-1",
  md: "text-sm px-3.5 py-1.5",
  lg: "text-sm px-4 py-2",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center gap-2 rounded font-medium transition-colors focus-ring ${variantMap[variant]} ${sizeMap[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
