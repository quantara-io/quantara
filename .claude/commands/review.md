---
description: Manually trigger quantara-reviewer on any PR (human-authored or agent-authored)
argument-hint: <pr-number>
---

Invoke the reviewer on PR **#$1**.

You are the orchestrator. Do not review the PR yourself. Your job is to:

1. **Validate the PR**:

   ```bash
   gh pr view $1 --json number,state,isDraft,baseRefName
   ```

   - Refuse if `gh pr view` errors (PR doesn't exist).
   - Refuse if `isDraft` is `true` — tell the user to mark it ready first.
   - If the PR is `CLOSED` or `MERGED`, proceed but tell the user this is a post-hoc audit review.

2. **Spawn the reviewer** via the `Agent` tool with `subagent_type: "quantara-reviewer"`. Pass exactly:

   ```
   Review PR #$1 on quantara-io/quantara following the reviewer contract in your system prompt.
   ```

3. **After the reviewer returns**, parse its structured output (`PR / ISSUE / DECISION / REASONS / CODEX_SECOND_OPINION`) and report a one-line summary to the user with the PR URL and decision.

No concurrency cap — multiple reviewers in parallel is fine (read-only on the PR).
No issue-label changes — this command is PR-centric, not issue-centric.
