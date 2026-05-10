# Changelog

All notable changes to Quantara are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version scheme is **CalVer** (`YYYY.MM.N`): year, month, and a zero-based patch counter that resets each month. The deploy workflow bumps `N` automatically on each successful prod deploy and appends an entry here.

## [Unreleased]

_Changes merged to `main` but not yet deployed to prod live here. The deploy workflow moves them under a versioned heading on each successful prod deploy._

## [2026.05.0] — 2026-05-10

Initial prod release scaffold. No production infrastructure has been applied yet; this entry marks the version baseline from which the CalVer counter starts.

### Added

- `VERSION` file at repo root (CalVer baseline `2026.05.0`)
- `CHANGELOG.md` (this file) in Keep-a-Changelog format
- `docs/RUNBOOK_PROD_DEPLOY.md` — step-by-step prod deploy and rollback guide
- Sub-issues filed for prod Terraform stacks (Phase A), SSM secrets (Phase B), deploy-prod CI workflow (Phase C), and cross-account ECR (Phase E)

[Unreleased]: https://github.com/quantara-io/quantara/compare/v2026.05.0...HEAD
[2026.05.0]: https://github.com/quantara-io/quantara/releases/tag/v2026.05.0
