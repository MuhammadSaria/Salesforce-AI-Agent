# Providus Nexus Phase 1 Progress

**Branch:** `feature/providus-phase1-execution`  
**Base:** `main`  
**Last updated:** 2026-08-01

## Repository Workflow Setup

- Status: Complete
- Verification: All required files are non-empty; stable paths resolve; all branch changes are limited to `AGENTS.md` and Markdown files under `docs/`; feature branch is pushed and ahead of `main`.
- Verification date: 2026-08-01

## Current Task

- Task: Phase 1 Task 3
- Status: Not started

## Completed Tasks

- Phase 1 Task 2: Add durable PostgreSQL job persistence
  - Implementation commit: e0eadeac118cee6a7c498d57f7813741b345520f
  - Verification/fix commit: 822ac011f13976d96c5ec93535680906595ba02d
  - Critical/important correction commit: 1691f560054a5e972190134ad4c0a479aade05d4
  - Verification date: 2026-08-01
  - Verification:
    - `cd middleware && docker compose ps` - PASS, `middleware-postgres-1` running and publishing `5432`.
    - `cd middleware && npm.cmd run migrate` - PASS.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/jobRepositoryPostgres.test.js test/postgresHelper.test.js` - PASS, 10 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 82 passing tests and 0 skipped.
  - Review:
    - Fixed migration regression found during diff review: active component locks now use a partial unique index so only one unreleased lease can exist per component.
  - Correction review:
    - Test database cleanup requires explicit `TEST_DATABASE_URL`, rejects non-`_test` database names before cleanup, and deletes only Providus-owned tables in foreign-key order.
    - `withTransaction()` now supplies a transaction-scoped repository and nested repository methods reuse the same PostgreSQL client.
    - Migrations run under a PostgreSQL advisory transaction lock and are idempotent under concurrent runners.
    - Job hydration uses a repeatable-read read-only transaction for a consistent aggregate snapshot.

- Phase 1 Task 1: Establish the Phase 1 direct-chat state model
  - Commit: 94de137
  - Correction commit: 5b4ff6cc741aeec0ff3423cc972b6458ea9170c8
  - Second correction commit: 5137298e2d2934524614580d0c7018c83b3a6703
  - Verification date: 2026-08-01
  - Verification:
    - `cd middleware && node --import ./test/setup.js --test test/developmentJob.test.js test/jobState.test.js test/jobStore.test.js test/jobPresentation.test.js` - PASS, 21 tests
    - `cd middleware && npm.cmd run check` - PASS, lint plus 71 tests

## Blockers

- None.

## Next Task

Start Phase 1 Task 3 only after explicit approval.

## Update Rules

- Update this file in the same commit as each implementation task.
- Record the pushed commit SHA after the commit is available; if that requires a follow-up documentation commit, record both SHAs.
- Do not mark a task complete without verification evidence.
- Record blockers factually without pasting long logs.
