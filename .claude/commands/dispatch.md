---
description: Dispatch a quantara-worker to a specific GitHub issue (manual)
argument-hint: <issue-number>
---

Dispatch a worker to issue **#$1**.

You are the orchestrator. Do not implement the issue yourself. Your job is to:

1. **Validate the issue is dispatchable**:
   ```bash
   gh issue view $1 --json number,title,labels,assignees,state
   ```
   Refuse if any of: state is closed; label `agent-claimed` already present; label `agent-ready` is missing; label `agent-forbidden` is present; an assignee is already set.

2. **Check concurrency cap** — refuse if 5+ issues currently carry the `agent-claimed` label:
   ```bash
   COUNT=$(gh issue list --label agent-claimed --state open --json number -q 'length')
   ```
   If `COUNT >= 5`, tell the user to wait for in-flight workers to finish or use `/agent-status` to inspect them.

3. **Spawn the worker** via the `Agent` tool with `subagent_type: "quantara-worker"` and `isolation: "worktree"`. The prompt to the worker must be self-contained — pass exactly the issue number and a one-line statement of the contract:
   ```
   Implement issue #$1 on quantara-io/quantara following the worker contract in your system prompt. Claim, worktree, implement, self-review, PR with auto-merge, stop.
   ```

4. **After the worker returns**, parse its structured output (`TASK_ID / ISSUE / BRANCH / PR / STATUS / NOTES`) and:
   - If `STATUS: merged-pending` → spawn `quantara-reviewer` with the PR number.
   - If `STATUS: needs-human-review` → tell the user, link the PR, do NOT spawn the reviewer (it would just escalate again).
   - If `STATUS: agent-blocked` → tell the user, link the issue.

5. **Report a one-line summary** to the user with the PR URL and what happens next.

Do not chain into another `/dispatch` or `/dispatch-next` after this — one issue per invocation.
