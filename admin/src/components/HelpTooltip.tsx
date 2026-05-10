/**
 * HelpTooltip — reusable inline glossary tooltip.
 *
 * Renders a small (?) trigger icon that opens a styled popover on hover and
 * focus. Supports keyboard navigation and screen-reader semantics.
 *
 * Usage:
 *   <HelpTooltip label="RSI" code="RSI = 100 - 100/(1+RS)">
 *     Relative Strength Index — a momentum oscillator that measures the speed
 *     and magnitude of recent price changes.
 *   </HelpTooltip>
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HelpTooltipProps {
  /** Short headline shown bold at top of popover. Required. */
  label: string;
  /** Body text (1–4 sentences). Plain text or React node. Required. */
  children: React.ReactNode;
  /** Optional inline formula or pseudocode rendered in monospace below body. */
  code?: string;
  /** Optional deep-link. Renders as "Learn more" footer link. */
  link?: { href: string; text?: string };
  /** Preferred position. Default "top". Auto-flips if too close to viewport edge. */
  position?: "top" | "bottom" | "left" | "right";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HelpTooltip({ label, children, code, link, position = "top" }: HelpTooltipProps) {
  const [open, setOpen] = useState(false);
  const [resolvedSide, setResolvedSide] = useState<"top" | "bottom" | "left" | "right">(position);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const tooltipId = `help-tooltip-${id.replace(/:/g, "")}`;

  // -------------------------------------------------------------------------
  // Auto-flip: pick the side with the most space when the preferred side would
  // overflow the viewport. Uses getBoundingClientRect — no external dep.
  // -------------------------------------------------------------------------
  const resolvePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const POPOVER_W = 288; // w-72
    const POPOVER_H = 160; // generous estimate

    const space = {
      top: rect.top,
      bottom: vh - rect.bottom,
      left: rect.left,
      right: vw - rect.right,
    };

    const preferred = position;

    // Check if the preferred side has enough room.
    const fits = (side: typeof position) => {
      if (side === "top" || side === "bottom") return space[side] >= POPOVER_H;
      return space[side] >= POPOVER_W;
    };

    if (fits(preferred)) {
      setResolvedSide(preferred);
      return;
    }

    // Find the side with most space.
    const best = (["top", "bottom", "left", "right"] as const).reduce((a, b) =>
      space[a] >= space[b] ? a : b,
    );
    setResolvedSide(best);
  }, [position]);

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  const openPopover = useCallback(() => {
    resolvePosition();
    setOpen(true);
  }, [resolvePosition]);

  const closePopover = useCallback(() => {
    setOpen(false);
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closePopover();
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closePopover]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: PointerEvent) {
      if (
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node) &&
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        closePopover();
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, closePopover]);

  // -------------------------------------------------------------------------
  // Popover position classes
  // -------------------------------------------------------------------------

  const positionClasses: Record<typeof resolvedSide, string> = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <span className="relative inline-flex items-center">
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        aria-describedby={open ? tooltipId : undefined}
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        onMouseEnter={openPopover}
        onMouseLeave={closePopover}
        onFocus={openPopover}
        onBlur={(e) => {
          // Keep open if focus moves into the popover itself
          if (popoverRef.current?.contains(e.relatedTarget as Node)) return;
          closePopover();
        }}
        onClick={() => (open ? closePopover() : openPopover())}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open ? closePopover() : openPopover();
          }
        }}
        className="inline-flex items-center justify-center text-muted2 hover:text-ink2 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/40 rounded-full transition-colors"
      >
        {/* 12x12 SVG circle-question icon */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle cx="6" cy="6" r="5.5" stroke="currentColor" />
          <text
            x="6"
            y="9"
            textAnchor="middle"
            fontSize="7"
            fontWeight="600"
            fill="currentColor"
            fontFamily="sans-serif"
          >
            ?
          </text>
        </svg>
      </button>

      {/* Popover */}
      {open && (
        <div
          ref={popoverRef}
          id={tooltipId}
          role="tooltip"
          className={`absolute z-50 w-72 rounded border border-line bg-surface p-3 shadow-lg text-xs text-ink ${positionClasses[resolvedSide]}`}
          // Allow focus to enter the popover (for links / keyboard nav)
          tabIndex={-1}
          onMouseEnter={openPopover}
          onMouseLeave={closePopover}
        >
          {/* Headline */}
          <p className="font-semibold text-ink mb-1">{label}</p>

          {/* Body */}
          <div className="text-ink2 leading-relaxed">{children}</div>

          {/* Optional code block */}
          {code && (
            <pre className="mt-2 font-mono text-[10px] text-muted bg-paper/60 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap">
              {code}
            </pre>
          )}

          {/* Optional link */}
          {link && (
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-brand hover:text-brand underline underline-offset-2"
            >
              {link.text ?? "Learn more"} &rarr;
            </a>
          )}
        </div>
      )}
    </span>
  );
}
