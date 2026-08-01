# Providus Nexus Phase 1 Progress

**Branch:** `feature/providus-phase1-execution`  
**Base:** `main`  
**Last updated:** 2026-08-01

## Repository Workflow Setup

- Status: Complete
- Verification: All required files are non-empty; stable paths resolve; all branch changes are limited to `AGENTS.md` and Markdown files under `docs/`; feature branch is pushed and ahead of `main`.
- Verification date: 2026-08-01

## Current Task

- Task: Phase 1 Task 5
- Status: Not started

## Completed Tasks

- Phase 1 Task 4: Enforce same-sandbox identity and permission claims
  - Implementation commit: 17f1a71dc4d746bc6093ba708a8dc934e1d506ed
  - Verification date: 2026-08-01
  - Verification:
    - `cd middleware && node --import ./test/setup.js --test test/sameOrgService.test.js test/apiAuth.test.js test/security.test.js` - RED first, failed for expected missing same-org service, missing production executor preflight, and permission-claim enforcement gaps.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/sameOrgService.test.js test/orgRouting.test.js test/apiAuth.test.js test/security.test.js test/conversationApi.test.js test/agentJiraIsolation.test.js` - PASS, 47 tests, 0 skipped.
    - `sf.cmd apex run test --tests AgentControllerTest --result-format human --wait 10 --target-org $env:PHASE1_SALESFORCE_ALIAS` - PASS against explicit alias `Developer-org`, 14 tests, 0 skipped, Org Id `00Dg500000E07e9EAB`.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 108 tests and 0 skipped.
  - Review:
    - `resolveSameOrg({ authenticatedOrgId, actorId })` resolves exactly one active connected registry entry matching the authenticated Salesforce org ID and rejects body/prompt/org-registry attempts to switch orgs.
    - `assertSameVerifiedOrg(orgContext, observed)` verifies organization ID, normalized instance URL, configured username, connected status, and non-production context before returning a frozen public context.
    - Salesforce Apex callouts send `X-Agent-User-Id`, `X-Agent-Org-Id`, `X-Agent-Can-Implement`, and `X-Agent-Can-Deploy`; middleware derives direct-action permissions from authenticated headers and ignores JSON-body role/org/permission claims.
    - Salesforce executor operations still require explicit org context, force `--target-org`, reject target mismatches, and block production contexts before CLI lookup.

- Phase 1 Task 3: Introduce direct conversation APIs and isolate Jira
  - Implementation commit: 4e7e42b
  - Correction commit: d12272ba1abfd23299545e6e74dde1076a114f18
  - Final message-isolation correction commit: 1c0b890318d5b89c98704875c628279b982030dc
  - Verification date: 2026-08-01
  - Verification:
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/conversationApi.test.js test/runtimeHealth.test.js` - RED first, failed for expected missing/direct-chat/Jira-readiness reasons.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/conversationApi.test.js test/apiAuth.test.js test/security.test.js test/runtimeHealth.test.js` - PASS, 27 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 92 passing tests and 0 skipped.
  - Correction verification:
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/conversationApi.test.js test/agentJiraIsolation.test.js` - RED first, failed for expected prompt 500 and incomplete Jira-disabled API/worker isolation reasons.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/conversationApi.test.js test/agentJiraIsolation.test.js` - PASS, 12 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/conversationApi.test.js test/apiAuth.test.js test/security.test.js test/agentQueue.test.js test/agentQueueFallback.test.js test/agentJiraIsolation.test.js test/runtimeHealth.test.js` - PASS, 36 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 99 tests and 0 skipped.
  - Final message-isolation correction verification:
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/conversationApi.test.js test/agentJiraIsolation.test.js` - RED first, failed for expected disabled Jira `/messages` bypass with 202 response and fallback worker error.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/conversationApi.test.js test/agentJiraIsolation.test.js` - PASS, 15 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 102 tests and 0 skipped.
  - Review:
    - New manual jobs use `source: salesforce-chat`, ignore Jira issue keys, and cannot enter the legacy Jira analyze path.
    - Jira webhook registration, poller startup, readiness checks, Jira comments, Jira revision activation, and Jira sync worker actions are gated by `JIRA_ENABLED=true`; default is false.
    - Owner/admin access isolation is enforced for job reads, conversation messages, and cancellation; approval routes remain role-gated.
  - Correction review:
    - Missing, empty, and whitespace-only prompts return stable 422 `PROMPT_REQUIRED` responses before sanitization; bounded-length and untrusted-input sanitization still run for present prompts.
    - Jira-specific analyze and instructions routes are unavailable when `JIRA_ENABLED=false`, while historical Jira job records remain readable.
    - Jira-source API mutations and queued implementation, validation, and deployment actions reject with stable 409 `JIRA_DISABLED` responses while Salesforce-chat workflows remain source-allowed.
  - Final message-isolation correction review:
    - Disabled Jira-source `/messages` requests now use the same mutable-job guard, return stable 409 `JIRA_DISABLED`, and leave conversation, audit, state history, status, and logs unchanged.
    - Salesforce-chat `/messages` still appends normally when Jira is disabled, and historical Jira `/messages` behavior remains available when Jira is enabled.

- Phase 1 Task 2: Add durable PostgreSQL job persistence
  - Implementation commit: e0eadeac118cee6a7c498d57f7813741b345520f
  - Verification/fix commit: 822ac011f13976d96c5ec93535680906595ba02d
  - Critical/important correction commit: 1691f560054a5e972190134ad4c0a479aade05d4
  - Final safety correction commit: 0bf9cc4cca63f78326122890309345e9ca4444ab
  - Verification date: 2026-08-01
  - Verification:
    - `cd middleware && docker compose ps` - PASS, `middleware-postgres-1` running and publishing `5432`.
    - `cd middleware && docker compose exec -T postgres psql -U providus -d postgres -c "SELECT datname FROM pg_database WHERE datname = 'providus_nexus_test'"` - PASS, dedicated test database exists.
    - `cd middleware && npm.cmd run migrate` - PASS.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/postgresHelper.test.js test/jobRepositoryPostgres.test.js` - PASS, 13 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:6543/providus_nexus_test'; node --import ./test/setup.js --test test/jobRepositoryPostgres.test.js` - FAIL as required, 6 failing live PostgreSQL tests and 0 skipped; failure message names `providus_nexus_test`, says to start PostgreSQL/Docker, and says the integration test was not executed.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:6543/providus_nexus_test'; npm.cmd run check` - FAIL as required, required PostgreSQL tests fail instead of skipping.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 85 passing tests and 0 skipped.
  - Review:
    - Fixed migration regression found during diff review: active component locks now use a partial unique index so only one unreleased lease can exist per component.
  - Correction review:
    - Test database cleanup requires explicit `TEST_DATABASE_URL`, rejects non-`_test` database names before cleanup, and deletes only Providus-owned tables in foreign-key order.
    - `withTransaction()` now supplies a transaction-scoped repository and nested repository methods reuse the same PostgreSQL client.
    - Migrations run under a PostgreSQL advisory transaction lock and are idempotent under concurrent runners.
    - Job hydration uses a repeatable-read read-only transaction for a consistent aggregate snapshot.
  - Final safety correction review:
    - Required PostgreSQL integration tests no longer skip when the configured test database is unavailable.
    - Test cleanup verifies `SELECT current_database()` equals the `_test` database parsed from `TEST_DATABASE_URL` before any table cleanup SQL executes.

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

Phase 1 Task 5: Reliable same-sandbox org inspection.

## Update Rules

- Update this file in the same commit as each implementation task.
- Record the pushed commit SHA after the commit is available; if that requires a follow-up documentation commit, record both SHAs.
- Do not mark a task complete without verification evidence.
- Record blockers factually without pasting long logs.
