<!--
For agent PRs:
- Branch must be named `agent/<slug>-<short-id>`
- Include `Agent-Task-ID: <id>` in the commit trailer
- Reviewer agent (quantara-reviewer) is dispatched automatically once this PR is open
For human PRs: this same template applies; the reviewer agent skips PRs not on `agent/*` branches
-->

## Issue
Closes #<!-- issue number -->

## Brief
<!-- Copy the issue's summary + acceptance criteria here so the PR is self-contained -->

## What changed
- 

## Test evidence
<!-- Paste output from typecheck + tests, or describe manual verification if non-code -->
```
$ npm run typecheck --workspaces
...
$ npm run test --workspace=quantara-backend
...
```

## Self-review checklist
- [ ] Diff matches the issue scope (no unrelated changes)
- [ ] Tests added or updated for new logic
- [ ] No tripwire areas touched (`backend/infra/**`, `.github/workflows/**`, `package.json` deps, `backend/src/middleware/auth.ts`, DynamoDB schema) — or escalation noted below
- [ ] Diff < 400 LOC — or escalation noted below
- [ ] Followed conventions in any matching `.claude/skills/quantara-*` skill

## Escalation (if any)
<!-- If a tripwire was crossed or the diff is large, explain why and what specifically a human should look at. Otherwise delete this section. -->
