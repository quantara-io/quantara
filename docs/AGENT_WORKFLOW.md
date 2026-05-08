# Agent Workflow Protocol

How AI agents (Claude, Codex, others) work on `quantara-io/quantara`. Humans read this on entry; agents reference it via the `quantara-worker` and `quantara-reviewer` system prompts.

## Roles

| Role           | Who                                              | Job                                                                                                                             |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Dispatcher** | Human (Nate), or `/dispatch-next` under autonomy | Picks an `agent-ready` issue, spawns a worker.                                                                                  |
| **Worker**     | `quantara-worker` (Sonnet) or Codex              | Implements one issue end-to-end in a worktree, opens a PR, enables auto-merge, stops.                                           |
| **Reviewer**   | `quantara-reviewer` (always Opus)                | Reviews diff against issue. Approves, requests changes, or escalates. Optionally invokes Codex for second opinion on tripwires. |
| **Human gate** | Nate                                             | Reviews any PR labeled `needs-human-review`. Approves or rejects.                                                               |

## Issue lifecycle

```
                                    ┌──── agent-blocked ──→ human unblocks ──┐
                                    │                                          ↓
agent-proposed ──[human triage]──→ agent-ready ──[claim]──→ agent-claimed ──→ PR open
                                                                                │
                                                                                ↓
                                                                         quantara-reviewer
                                                                          /     |      \
                                                                  APPROVE  CHANGES   ESCALATE
                                                                     │       │          │
                                                                     ↓       ↓          ↓
                                                              auto-merge  worker    needs-human-review
                                                              on CI green iterates       │
                                                                                          ↓
                                                                                   human review
                                                                                          │
                                                                                          ↓
                                                                                  approve / merge
```

## Labels (the source of truth)

| Label                | Meaning                                                               | Set by                           |
| -------------------- | --------------------------------------------------------------------- | -------------------------------- |
| `agent-proposed`     | Agent suggested this; human triages before dispatch                   | Agent (via feature template)     |
| `agent-ready`        | Dispatchable. Has acceptance criteria.                                | Human (or feature/bug templates) |
| `agent-claimed`      | A worker is currently on it                                           | Worker, on claim                 |
| `agent-blocked`      | Worker gave up; needs human help                                      | Worker                           |
| `agent-forbidden`    | Off-limits to agents                                                  | Human                            |
| `needs-human-review` | Reviewer escalated; human is the gate                                 | Reviewer agent                   |
| `awaiting-review`    | Auto-merge skipped (no branch protection); reviewer is the merge gate | Worker                           |
| `agent-reviewed`     | Reviewer approved; ready to merge                                     | Reviewer agent                   |
| `priority:high`      | Dispatcher picks first                                                | Human                            |

## Branches

- Format: `agent/<slug>-<short-id>` (e.g. `agent/fix-cold-start-health-41-a3f9c1`).
- Created via `gh issue develop` — atomic, fails if name collides → free mutex against double-claim.
- Reviewer matches PRs by `head:agent/` prefix. Codex-authored PRs use the same prefix.

## Worktrees

- Path: `~/.quantara-worktrees/<task-id>` (outside repo).
- Created by worker: `git worktree add ~/.quantara-worktrees/<task-id> agent/<slug>-<id>`.
- Cleanup: on PR close (merged or closed) — see [Cleanup](#cleanup) below.

## Tripwires (escalate, never auto-merge)

A diff that touches **any** of these forces `needs-human-review`:

- `backend/infra/**` (Terraform / IaC)
- `.github/workflows/**` (CI/CD)
- Any `package.json` dependency change (any workspace)
- `backend/src/middleware/auth.ts`
- DynamoDB table or GSI schema change
- Diff > 400 LOC (additions + deletions)
- New `import` from a package not currently in the workspace's `package.json`

Tune the list over time. Loosen as confidence grows.

## Concurrency

- Cap: **5 concurrent workers** (issues with `agent-claimed`).
- Dispatcher (`/dispatch-next`) checks the count and skips when at cap.
- Stale worker detection (>1h no activity): surfaced by `/agent-status`. You decide to kill or wait.

## Slash commands

| Command              | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `/dispatch <issue#>` | Spawn worker on a specific issue                                       |
| `/dispatch-next`     | Spawn worker on the next eligible issue (one at a time)                |
| `/agent-status`      | Inspect in-flight workers, PRs, worktrees, escalations                 |
| `/review <pr#>`      | Manually trigger reviewer on any PR (human-authored or agent-authored) |

For unattended runs: `/loop 10m /dispatch-next` or `/schedule` (see those skills).

## Models

- **Worker**: Sonnet by default (cheaper for parallel work). Codex is also valid — same branch convention and PR template apply.
- **Reviewer**: always Opus. Reviewer is diff-blind: reads only the diff + linked issue, not the worker's reasoning.
- **Codex second-opinion**: invoked by the reviewer **only on tripwire PRs** for an independent challenge pass.

## Setup checklist (one-time, run as Nate)

### GitHub plan requirements

> **Private repos on GitHub Free do not support branch protection rules or auto-merge.**
>
> - **Branch protection** (require PR + approving review + status checks) requires **GitHub Pro or Team** on a private repo.
> - **Auto-merge** (`gh pr merge --auto`) is silently ignored by the API on Free private repos — the PR is merged immediately without waiting for CI or reviews.
> - On Free, the worker's `gh pr merge --auto --squash` step has no effect (the PR stays open until manually merged or the reviewer merges it). See the companion auto-merge issue for the full fix.
>
> If you are on the Free plan and using a private repo, skip steps 2 and 4 of this checklist. The reviewer will still run and can merge manually, but there will be no CI gate.

### 1. Create labels

```bash
cd /Users/nate/aldero.io/quantara
# Uses '|' as the separator so names containing ':' (e.g. priority:high) parse correctly.
for label in \
  "agent-proposed|CCCCCC|Agent suggested this; human triages" \
  "agent-ready|0E8A16|Dispatchable by an agent" \
  "agent-claimed|FBCA04|A worker is on it" \
  "agent-blocked|D93F0B|Worker gave up; needs human" \
  "agent-forbidden|000000|Off-limits to agents" \
  "needs-human-review|B60205|Reviewer escalated; human gates merge" \
  "awaiting-review|5319E7|Auto-merge skipped; reviewer is the merge gate" \
  "agent-reviewed|0E8A16|Reviewer approved; ready to merge" \
  "priority:high|E11D21|Dispatcher picks first" \
  "tech|BFD4F2|Tech task / refactor" \
  "bug|D73A4A|Something is broken" \
  "feature|A2EEEF|New feature or enhancement" \
  ; do
  IFS='|' read name color desc <<< "$label"
  gh label create "$name" --color "$color" --description "$desc" 2>/dev/null \
    || gh label edit "$name" --color "$color" --description "$desc"
done
```

### 2. Branch protection on `main`

Via UI (Settings → Branches → main) or CLI:

- Require a pull request before merging
- Require **1 approving review** (the reviewer agent's APPROVE counts)
- Require status checks: whatever your `ci.yml` workflow runs (typecheck, tests)
- Require branches to be up to date before merging
- **Allow auto-merge** must be enabled on the repo (Settings → General → Pull Requests)

### 3. Trust your reviewer agent's identity

The reviewer uses the **`quantara-reviewer-bot` GitHub App** (App ID `3502236`, Installation ID `127048091`) so its `--approve` calls register as a real `APPROVED`-state review rather than a `COMMENTED` review (GitHub blocks self-review on personal accounts, which would silently downgrade the state).

The reviewer mints a short-lived installation token at review time via `tools/github-app-token.sh`. Set three env vars in your shell or CI environment:

| Variable                   | Value                                |
| -------------------------- | ------------------------------------ |
| `REVIEWER_APP_ID`          | `3502236`                            |
| `REVIEWER_INSTALLATION_ID` | `127048091`                          |
| `REVIEWER_APP_KEY_PATH`    | Path to the App private key (`.pem`) |

Store the private key locally — never commit it:

```bash
mkdir -p "$HOME/.config/quantara"
cp /path/to/downloaded/quantara-reviewer-bot.pem "$HOME/.config/quantara/reviewer-bot.pem"
chmod 600 "$HOME/.config/quantara/reviewer-bot.pem"
# Then export:
export REVIEWER_APP_KEY_PATH="$HOME/.config/quantara/reviewer-bot.pem"
```

If these env vars are absent, the reviewer falls back to the default `GH_TOKEN` identity. The review still completes, but registers as `COMMENTED` rather than `APPROVED` and will not satisfy a branch-protection approval requirement.

Branch protection must also **add `quantara-reviewer-bot` as an allowed reviewer** (Settings → Branches → main → required reviews) for the App approval to count toward the required count.

### 4. Disable Codex/agent push to `main`

Branch protection should already cover this, but double-check that no automation has bypass permission.

## Cleanup

The cleanup script is `tools/agent-sweep.sh` (committed to the repo). It walks `~/.quantara-worktrees/`, checks each branch's PR state on GitHub, and removes worktrees whose PR has closed (merged or rejected). Safe to run repeatedly.

Run manually:

```bash
./tools/agent-sweep.sh
```

For automatic cleanup on macOS, register a LaunchAgent (one-time, per-machine — **not** committed because the plist contains user-specific paths).

Create `~/Library/LaunchAgents/com.quantara.agent-sweep.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.quantara.agent-sweep</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/nate/aldero.io/quantara/tools/agent-sweep.sh</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/quantara-agent-sweep.log</string>
  <key>StandardErrorPath</key><string>/tmp/quantara-agent-sweep.log</string>
</dict>
</plist>
```

Activate:

```bash
launchctl load ~/Library/LaunchAgents/com.quantara.agent-sweep.plist
```

Sweeps every 30 min, runs on login, survives reboots. Logs to `/tmp/quantara-agent-sweep.log`.

To remove:

```bash
launchctl unload ~/Library/LaunchAgents/com.quantara.agent-sweep.plist
rm ~/Library/LaunchAgents/com.quantara.agent-sweep.plist
```

If you need cleanup to fire on PR close _immediately_ rather than within 30 min, that requires either a webhook receiver (public endpoint on your machine) or a self-hosted GitHub Actions runner — both significantly more infra than the 30-min poll is worth.

## Failure modes (and what happens)

| Failure                                    | Result                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Two agents claim same issue simultaneously | `gh issue develop` fails for the second (branch collision). It stops.   |
| Worker can't make tests pass               | Labels issue `agent-blocked`, comments failure, unassigns.              |
| Reviewer rejects 4 times                   | Auto-escalate to `needs-human-review`.                                  |
| CI flakes after auto-merge enabled         | GitHub re-runs; if it stays red, auto-merge cancels.                    |
| Worker crashes mid-task                    | Worktree stays. `/agent-status` flags as stale. Human kills or resumes. |
| Merged PR breaks main                      | Manual `gh pr revert <n>` for now. (See "Rollback" below.)              |

## Rollback

Day 1: manual revert via `gh pr revert <n>`. If you find yourself reverting more than once a week, consider a watchdog (post-merge CI monitor) that auto-opens revert PRs.

## What this protocol is NOT

- Not a way for agents to do _anything_ unsupervised. Tripwires + diff budget + reviewer gating is the whole point.
- Not a CI replacement. CI still runs and still gates merges.
- Not a substitute for code review on architectural changes. Anything touching tripwires goes to a human.

## Versioning this doc

This doc is the contract. When you change tripwires, labels, or escalation rules, update this file in the same PR. Workers and reviewers should re-read it on every dispatch.
