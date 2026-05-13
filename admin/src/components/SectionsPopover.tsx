import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { useLocation, useNavigate } from "react-router-dom";

interface Section {
  label: string;
  to: string;
}

// All 13 routes grouped in 2 columns (left / right pairs)
const SECTION_PAIRS: [Section, Section | null][] = [
  [
    { label: "Workstation", to: "/" },
    { label: "Signals", to: "/genie" },
  ],
  [
    { label: "Market", to: "/market" },
    { label: "News", to: "/news" },
  ],
  [
    { label: "Whitelist", to: "/whitelist" },
    { label: "Ratifications", to: "/ratifications" },
  ],
  [
    { label: "Performance", to: "/performance" },
    { label: "Health", to: "/health" },
  ],
  [
    { label: "Pipeline", to: "/pipeline" },
    { label: "Activity", to: "/activity" },
  ],
  [
    { label: "Ops", to: "/ops" },
    { label: "PnL", to: "/pnl" },
  ],
  [
    { label: "Backtest", to: "/backtest" },
    { label: "Glossary", to: "/admin/glossary" },
  ],
];

// Flattened list for keyboard navigation
const ALL_SECTIONS: Section[] = SECTION_PAIRS.flatMap(([left, right]) =>
  right ? [left, right] : [left],
);

// ── Pure helpers (exported for unit tests) ────────────────────────────────────

/**
 * Returns true iff a click at `target` should close the popover.
 *
 * Critical: the trigger element lives OUTSIDE `containerEl`, so a naive
 * "is target inside container" check causes a toggle race — the document
 * mousedown fires first and closes the popover, then the trigger's `click`
 * fires and toggles it back open. Excluding the trigger from the
 * outside-click check fixes that.
 */
export function isOutsideClick(
  target: Node | null,
  containerEl: { contains: (n: Node) => boolean } | null,
  triggerEl: { contains: (n: Node) => boolean } | null,
): boolean {
  if (!target) return false;
  if (containerEl?.contains(target)) return false;
  if (triggerEl?.contains(target)) return false;
  return true;
}

/**
 * Computes the next element to focus when the user presses Tab/Shift+Tab
 * inside the popover, implementing wrap-around at the boundaries.
 *
 * Returns `null` if focus should be allowed to proceed normally (no trap
 * action needed). Returns the element to focus and the caller should
 * `preventDefault()` and call `.focus()` on it.
 */
export function getNextFocusElement<T>(
  active: T | null,
  focusables: readonly T[],
  shiftKey: boolean,
): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

interface SectionsPopoverProps {
  onClose: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
}

export function SectionsPopover({ onClose, triggerRef }: SectionsPopoverProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedIndexRef = useRef<number>(-1);

  // Auto-focus the dialog on mount so Esc / Arrow keys are reachable
  // without a manual Tab. Without this the keyboard handler is dead-code
  // until focus enters the popover.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Restore focus to the trigger when the popover unmounts (on close).
  // Without this, focus is left on the last focused popover item or
  // dropped to <body>, which violates issue #245's a11y spec.
  useEffect(() => {
    return () => {
      triggerRef?.current?.focus();
    };
  }, [triggerRef]);

  // Close on outside click — but EXCLUDE the trigger element from the
  // outside-click check, otherwise the trigger's click handler races
  // with this and the popover gets stuck open.
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (
        isOutsideClick(e.target as Node | null, containerRef.current, triggerRef?.current ?? null)
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onClose, triggerRef]);

  // Focus trap: keep Tab inside the popover while open. Without this,
  // Tab walks past the dialog into the page underneath, violating
  // aria-modal="true" and the issue spec.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusables = Array.from(root!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const next = getNextFocusElement(
        document.activeElement as HTMLElement | null,
        focusables,
        e.shiftKey,
      );
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Close on Esc, handle arrow key navigation
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items =
        containerRef.current?.querySelectorAll<HTMLButtonElement>("[data-section-item]");
      if (!items || items.length === 0) return;
      const len = items.length;
      if (e.key === "ArrowDown") {
        focusedIndexRef.current = (focusedIndexRef.current + 1) % len;
      } else {
        focusedIndexRef.current = (focusedIndexRef.current - 1 + len) % len;
      }
      items[focusedIndexRef.current]?.focus();
    }
  }

  function isActive(to: string): boolean {
    if (to === "/") return location.pathname === "/";
    return location.pathname === to || location.pathname.startsWith(to + "/");
  }

  function navigate2(to: string) {
    navigate(to);
    onClose();
  }

  return (
    // Backdrop — catches outside clicks via the mousedown handler above
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Sections"
      aria-modal="true"
      tabIndex={-1}
      className="absolute right-0 top-full mt-1.5 z-50 w-64 rounded-lg border border-line bg-paper shadow-lg ring-1 ring-black/5 dark:ring-white/5 focus:outline-none"
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="px-3 pt-3 pb-1.5">
        <span className="text-2xs font-semibold uppercase tracking-widest text-muted2">
          Sections
        </span>
      </div>

      {/* 2-col grid */}
      <div className="px-2 pb-2">
        {SECTION_PAIRS.map(([left, right], rowIdx) => (
          <div key={rowIdx} className="grid grid-cols-2 gap-0.5">
            <SectionItem section={left} active={isActive(left.to)} onNavigate={navigate2} />
            {right ? (
              <SectionItem section={right} active={isActive(right.to)} onNavigate={navigate2} />
            ) : (
              <div />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Expose ALL_SECTIONS for tests
export { ALL_SECTIONS };

interface SectionItemProps {
  section: Section;
  active: boolean;
  onNavigate: (to: string) => void;
}

function SectionItem({ section, active, onNavigate }: SectionItemProps) {
  return (
    <button
      type="button"
      data-section-item
      onClick={() => onNavigate(section.to)}
      className={`flex items-center gap-2 w-full rounded px-2 py-1.5 text-sm transition-colors focus-ring text-left ${
        active ? "text-ink font-medium" : "text-muted hover:text-ink hover:bg-sunken/60"
      }`}
      aria-current={active ? "page" : undefined}
    >
      {/* Bullet dot — filled brand color when active, hollow otherwise */}
      <span
        className={`shrink-0 w-1.5 h-1.5 rounded-full ${
          active ? "bg-brand" : "border border-line-strong bg-transparent"
        }`}
        aria-hidden="true"
      />
      {section.label}
    </button>
  );
}
