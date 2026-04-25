#!/usr/bin/env bash
# Sweep agent worktrees whose PR has closed (merged or rejected).
# Safe to run repeatedly. Run via LaunchAgent (see docs/AGENTS.md) or manually.
set -euo pipefail

REPO=/Users/nate/aldero.io/quantara
WT_ROOT="$HOME/.quantara-worktrees"

[ -d "$WT_ROOT" ] || exit 0
command -v gh >/dev/null || { echo "agent-sweep: gh not found, skipping" >&2; exit 0; }

for wt in "$WT_ROOT"/*/; do
  [ -d "$wt" ] || continue
  branch=$(git -C "$wt" symbolic-ref --short HEAD 2>/dev/null) || continue
  case "$branch" in
    agent/*) ;;
    *) continue ;;
  esac
  state=$(gh pr list --repo quantara-io/quantara --head "$branch" --state all --limit 1 --json state -q '.[0].state' 2>/dev/null || echo "")
  if [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ]; then
    echo "agent-sweep: removing $wt (PR $state, branch $branch)"
    git -C "$REPO" worktree remove "$wt" --force || true
    git -C "$REPO" branch -D "$branch" 2>/dev/null || true
  fi
done

git -C "$REPO" worktree prune
