---
description: Show in-flight agent issues, PRs, worktrees, and stale workers
---

Print a human-readable status table for the agent workflow. No state changes — read-only.

## What to print

### 1. In-flight issues
```bash
gh issue list --label agent-claimed --state open \
  --json number,title,assignees,updatedAt \
  --template '{{range .}}#{{.number}}  {{.title}}  (last: {{timeago .updatedAt}}){{"\n"}}{{end}}'
```

### 2. Open agent PRs (CI state included)
```bash
gh pr list --search 'head:agent/' --state open \
  --json number,title,headRefName,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,updatedAt \
  --template '{{range .}}#{{.number}}  {{.title}}  branch={{.headRefName}}  ci={{.mergeStateStatus}}  review={{.reviewDecision}}  updated={{timeago .updatedAt}}{{"\n"}}{{end}}'
```

### 3. Local worktrees
```bash
git -C /Users/nate/aldero.io/quantara worktree list
ls -lt ~/.quantara-worktrees/ 2>/dev/null
```

### 4. Stale workers (any worktree with last commit > 1 hour ago, or branch with no commits in 1h)
For each worktree under `~/.quantara-worktrees/`:
```bash
for wt in ~/.quantara-worktrees/*/; do
  if [ -d "$wt/.git" ] || [ -f "$wt/.git" ]; then
    last=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
    age=$(( $(date +%s) - last ))
    if [ "$age" -gt 3600 ]; then
      echo "STALE: $wt (last commit ${age}s ago)"
    fi
  fi
done
```

### 5. Escalations awaiting human
```bash
gh pr list --label needs-human-review --state open --json number,title,url \
  --template '{{range .}}#{{.number}}  {{.title}}  {{.url}}{{"\n"}}{{end}}'
gh issue list --label agent-blocked --state open --json number,title,url \
  --template '{{range .}}#{{.number}}  {{.title}}  {{.url}}{{"\n"}}{{end}}'
```

## Output format

Print sections with clear headers. Color or emoji optional. Example:

```
== In-flight (3/5) ==
#41  bug: candle backfill misses Jan 1   (last: 12m ago)
#42  tech: extract OHLCV helper           (last: 4m ago)
#43  bug: /health 500 on cold start       (last: 47m ago)

== Agent PRs ==
#101 fix(backend): handle Jan 1 rollover  ci=BLOCKED  review=APPROVED  updated=8m
#102 refactor(ingestion): ohlcv helper    ci=PENDING  review=null      updated=4m

== Worktrees ==
~/.quantara-worktrees/41-a3f9c1
~/.quantara-worktrees/42-b8d2e7
~/.quantara-worktrees/43-c1f4a2

== Stale workers ==
STALE: ~/.quantara-worktrees/43-c1f4a2 (last commit 2820s ago)

== Awaiting human ==
PRs needing review:
  (none)
Blocked issues:
  #38  bug: SSE reconnect loop  (agent-blocked)
```

## Hard rules

- Read-only. Do not unassign, relabel, or kill anything based on the status. The user makes those calls after seeing the output.
- If a worktree is "stale" but the PR is approved + waiting on CI, that's fine — flag but don't recommend action.
