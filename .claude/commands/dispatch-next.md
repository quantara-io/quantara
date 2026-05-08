---
description: Pick the next agent-ready issue and dispatch a worker (autonomous mode)
---

Pick the highest-priority `agent-ready` issue and dispatch a worker. Designed to be wrapped in `/loop` or `/schedule` for unattended runs.

Steps:

1. **Concurrency check first** — if 5+ open issues already carry `agent-claimed`, exit with "at cap, skipping" and stop. Do not block.

   ```bash
   COUNT=$(gh issue list --label agent-claimed --state open --json number -q 'length')
   [ "$COUNT" -ge 5 ] && echo "at cap" && exit 0
   ```

2. **Find the next issue**. Priority order:
   1. Label `priority:high` + `agent-ready`
   2. Label `bug` + `agent-ready` (bugs before tech tasks)
   3. Label `tech` + `agent-ready`
   4. Anything else with `agent-ready`

   ```bash
   ISSUE=$(gh issue list --label agent-ready --state open \
     --json number,labels,createdAt \
     -q 'sort_by(.createdAt) | map(select(.labels | map(.name) | index("agent-forbidden") | not)) | .[0].number')
   ```

   If no eligible issue, exit with "nothing to do" and stop.

3. **Dispatch** by invoking `/dispatch <issue>` (or directly spawning `quantara-worker` with that issue number — same effect).

4. **One issue per run.** Even if more are eligible, do not loop here — that's `/loop`'s job. Exiting cleanly lets the scheduler decide cadence.

5. **Report**: one line — issue dispatched, worker task ID, or "nothing to do".

## Autonomy patterns

- Manual: `/dispatch-next` (you fire it).
- Periodic: `/loop 10m /dispatch-next` (uses the loop skill, polls every 10 minutes).
- Cron: `/schedule` to set this up as a scheduled remote agent (see /schedule skill docs).

## Hard rules

- Never claim an issue without a valid label and no existing assignee — defer to the worker's claim step which is atomic via `gh issue develop`.
- Never run more than one worker per invocation.
- Never spawn a reviewer here — that happens after the worker reports back, inside `/dispatch`.
