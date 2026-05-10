# ⌘K Command Palette — Design v0

Status: design approved, dispatched as issues #313 / #314 / #315 / #316. Targets the admin workstation.

## Why

The current top-bar search input is decoration — it doesn't do anything. Traders move between symbols, recall recent signals, and run actions (switch timeframe, close position, toggle overlay) constantly. A keyboard-first command palette closes the loop so the mouse becomes optional.

Three jobs, in priority order:

1. **Symbol switching** — `⌘K → ETH → ↵` and the chart switches. The #1 reason anyone touches a search bar in a trading UI.
2. **Signal recall** — "didn't I see a bull div on SOL yesterday?" → find it without scrolling the right rail.
3. **Action commands** — `/tf 4h`, `/close BTC`, `/toggle ema50`.

## Form

**Modal**, dim backdrop, centered, max-w-2xl. Confirmed over the inline-anchored variant — if you're using ⌘K you've already context-switched; keeping the chart visible behind the search adds visual noise without changing what the user is trying to do.

Library: [`cmdk`](https://cmdk.paco.me/). Headless, accessible, ~10kb gz, used by Vercel/Linear/Raycast. Don't roll our own — the keyboard semantics and screen-reader handling are surprisingly subtle.

## Sections (display order, recency-weighted within each)

| Section  | Source                                     | Empty-state visible?         | Max rows  |
| -------- | ------------------------------------------ | ---------------------------- | --------- |
| Recent   | localStorage last-5 symbols                | yes                          | 5         |
| Markets  | hard-coded `PAIRS` constant                | no (only when query matches) | 6         |
| Signals  | `GET /api/admin/signals?symbol=X&limit=10` | no                           | 5         |
| Alerts   | future `/api/alerts` endpoint              | no                           | 3         |
| Commands | client-side registry                       | when query starts with `/`   | unlimited |
| Jump-to  | static nav routes                          | yes                          | 4         |

## Visual states

### Empty (just opened)

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 Search or run command…                              esc │
├─────────────────────────────────────────────────────────────┤
│ RECENT                                                       │
│   B  BTC/USD              72,092    ▼3.63%        ⌘1        │
│   E  ETH/USD               3,789    ▲1.12%        ⌘2        │
│   S  SOL/USD              218.74    ▲4.83%        ⌘3        │
│                                                              │
│ JUMP TO                                                      │
│   ⚡ Active alerts                                  ⌘.       │
│   📊 Watchlist                                               │
│   🎯 Positions                                               │
│   ⚙  Settings                                                │
│                                                              │
│ /  command mode    #  signal search    esc  close           │
└─────────────────────────────────────────────────────────────┘
```

### Query "eth"

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 eth                                                 esc │
├─────────────────────────────────────────────────────────────┤
│ MARKETS                                                      │
│   E  ETH/USD               3,789    ▲1.12%           ↵      │
│                                                              │
│ SIGNALS · ETH (last 7d)                                      │
│   ↑ Buy        Reclaimed 20-EMA            74,775   May 12  │
│   ↑ Bull Div   Lower lows, higher RSI      74,704   May 11  │
│                                                              │
│ ALERTS                                                       │
│   ETH RSI < 30                                  ⏰ armed     │
└─────────────────────────────────────────────────────────────┘
```

### Command mode (`/`)

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 /                                                   esc │
├─────────────────────────────────────────────────────────────┤
│ COMMANDS                                                     │
│   /alert <sym> <op> <value>    Create price alert            │
│   /tf <15m|1h|4h|1d|1w>        Switch timeframe              │
│   /close <sym>                 Close position                │
│   /toggle <ema20|ema50|vol>    Toggle chart overlay          │
│   /mute <sym> <duration>       Mute alerts for symbol        │
└─────────────────────────────────────────────────────────────┘
```

### Live preview during a command (`/alert btc > 70000`)

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 /alert btc > 70000                                  esc │
├─────────────────────────────────────────────────────────────┤
│ PREVIEW                                                      │
│   BTC/USD price crosses above 70,000                         │
│   Current 72,092  •  Already above threshold                │
│   ⚠ Will fire on cross-back below 70,000                    │
│                                                              │
│   ↵  Create alert                                            │
└─────────────────────────────────────────────────────────────┘
```

## Keyboard

- `⌘K` / `Ctrl+K` open, `esc` close
- `↑`/`↓` navigate, `↵` commit, `tab` cycle sections
- `⌘1-9` jump directly to recent symbol (works even when palette closed)
- `/` forces command mode (clears query, repopulates registry list)
- `#` forces signal-only search (skips Markets section)
- `⌥+↵` reserved for "open in split view" once split view exists; no-op in v0

## Ranking

Per section:

```
score = fuzzy(query, label) * 0.6 + recencyDecay(lastUsed) * 0.4

recencyDecay:
  used  <1h ago  → 1.0
  used   today   → 0.5
  used  past 7d  → 0.1
  older          → 0
```

The 0.4 weight on recency is what makes `⌘K → b → ↵` land on BTC even though "BCH" is alphabetically closer.

## Data wiring (minimal first pass)

| Need                    | Source today                             | Gap                                         |
| ----------------------- | ---------------------------------------- | ------------------------------------------- |
| Markets list            | `packages/shared/src/constants/pairs.ts` | none — static import                        |
| Recent signals          | `/api/admin/signals?symbol=X`            | filter param already supported              |
| Current prices for rows | existing `/api/admin/market` poll        | none — lift to Workstation context          |
| Alerts list             | n/a                                      | future — placeholder section, hide if empty |

## Rollout

Four issues, dispatched in order:

1. **#313 foundation** — modal shell, cmdk wire-up, ⌘K binding, Recent + Jump-to from localStorage. No data deps.
2. **#314 Markets** — fuzzy symbol search, recency-weighted ranking, ⌘1-9 chart-switch hotkeys. Depends on #313.
3. **#315 Signals** — `/api/admin/signals?symbol=X` integration, `#` mode for signal-only search. Depends on #313 (parallel with #314).
4. **#316 Commands** — `/tf`, `/close`, `/toggle` with live preview. Depends on #313 (parallel with #314/#315).

`/alert` and `/mute` ship later once the alerts subsystem is in place. `/force-indicators` is admin-only and routes through Settings until #299 is redesigned.

## What's deliberately not in v0

- Mute-symbol affordance (depends on alerts subsystem)
- `/alert` command (depends on alerts subsystem)
- `⌥+↵` split view (no split view exists yet)
- Server-side fuzzy search of signal labels (small PAIRS set + 10-row signal cache makes it unnecessary)
- Multi-step wizards / multi-page palettes (v1+ if there's demand)

## A11y notes

- `role="dialog"`, `aria-modal="true"`
- Focus trap inside the modal; focus restored to the trigger on close
- Highlighted row has a clear focus ring, not just a hover color
- All keyboard shortcuts surfaced visibly on the row that owns them
