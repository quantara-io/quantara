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
   - If `STATUS: merged-pending` → spawn `quantara-reviewer` with the PR number, then run the codex second-opinion step (#5).
   - If `STATUS: awaiting-review` → spawn `quantara-reviewer` with the PR number (auto-merge was skipped because branch protection is unavailable; reviewer approval is the merge gate), then run the codex second-opinion step (#5).
   - If `STATUS: needs-human-review` → tell the user, link the PR, do NOT spawn the reviewer (it would just escalate again). Skip the codex step — human review is the gate now.
   - If `STATUS: agent-blocked` → tell the user, link the issue. Skip the codex step.

5. **Codex second-opinion review** (only when the reviewer ran in step #4). Independent advisory pass — runs regardless of the reviewer's verdict (APPROVE / CHANGES / ESCALATE). Surfaced verbatim alongside the reviewer's output; never gates merge.

   The codex companion script reviews the local working tree, so set up a worktree at the PR's HEAD first:

   ```bash
   PR=<pr-number>
   git fetch origin pull/$PR/head:pr-$PR-codex
   git worktree add /tmp/pr-$PR-codex pr-$PR-codex
   ```

   Then run codex review in the background from inside that worktree:

   ```bash
   cd /tmp/pr-$PR-codex && \
     node "/Users/nate/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" review ""
   ```

   Use `Bash(..., run_in_background: true)`. When the task completes, read the output file and surface its `# Codex Review` block **verbatim** — do not paraphrase, summarize, or fix anything. The trailing `""` is required (no focus-text — the script rejects custom focus arguments under `/codex:review`).

   **Post the codex output as a PR comment regardless of verdict** — even when codex finds no concerns. This creates a permanent record on the PR for human reviewers and future audits.

   ```bash
   CODEX_BODY=$(awk '/^# Codex Review/,0' /private/tmp/.../<task-output-file>)
   gh pr comment $PR --body "$(printf '**Codex second-opinion review** (automated)\n\n%s' "$CODEX_BODY")"
   ```

   The `**Codex second-opinion review** (automated)` prefix marks the comment as machine-generated so a future filter or human can distinguish it from human review feedback.

   If codex flags real issues that the in-house reviewer missed, file a follow-up issue rather than blocking the current PR.

6. **Report a one-line summary** to the user with the PR URL and what happens next (e.g. "PR #30 approved by reviewer; codex review running in background, will surface when done").

Do not chain into another `/dispatch` or `/dispatch-next` after this — one issue per invocation.
