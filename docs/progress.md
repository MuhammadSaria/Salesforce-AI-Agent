# Providus Nexus Phase 1 Progress

**Branch:** `feature/providus-phase1-execution`  
**Base:** `main`  
**Last updated:** 2026-08-02

## Repository Workflow Setup

- Status: Complete
- Verification: All required files are non-empty; stable paths resolve; all branch changes are limited to `AGENTS.md` and Markdown files under `docs/`; feature branch is pushed and ahead of `main`.
- Verification date: 2026-08-01

## Current Task

- Task: Phase 1 Task 6
- Status: Not started

## Completed Tasks

- Phase 1 Task 5: Build deterministic org inspection for Flow work
  - Implementation commit: 70bea0deb1605fd32d4ef784f5711e77e486d88b
  - Correction commit: d1ad742
  - Tooling/large-object/retrieval-evidence correction commit: 9469387
  - Deterministic FieldDefinition/picklist/retrieve-adapter correction commit: pending push
  - Verification date: 2026-08-02
  - Verification:
    - `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js` - RED first, failed for expected missing `orgInspectionService.js`.
    - `cd middleware && node --import ./test/setup.js --test test/metadataCapabilities.test.js` - RED first for the operation-policy regression, failed because `retrieveMetadata` did not yet reject disallowed retrieve operations before CLI execution.
    - `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataScope.test.js test/metadataCapabilities.test.js` - PASS, 14 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --input-type=module -e "import pg from 'pg'; const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect(); const r = await c.query('select current_database() as db, inet_server_addr() as addr, inet_server_port() as port'); console.log(JSON.stringify(r.rows[0])); await c.end();"` - PASS, connected to `providus_nexus_test` on PostgreSQL port 5432.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/apiAuth.test.js test/sameOrgService.test.js test/security.test.js test/agentSameOrg.test.js test/conversationApi.test.js test/developmentJob.test.js test/jobState.test.js test/jobStore.test.js test/orchestrator.test.js test/sfFailureMessage.test.js` - PASS, 97 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 161 tests and 0 skipped.
  - Correction verification:
    - `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js` - RED first, failed for expected realistic discovery, fake EntityDefinition row rejection, bounded-query enforcement, malformed component rejection, retrieval-failure handling, connected relationship guard, and context freshness gaps.
    - `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataScope.test.js test/metadataCapabilities.test.js` - PASS, 17 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --input-type=module -e "import pg from 'pg'; const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect(); const r = await c.query('select current_database() as db, inet_server_addr() as addr, inet_server_port() as port'); console.log(JSON.stringify(r.rows[0])); await c.end();"` - PASS, connected to `providus_nexus_test` on PostgreSQL port 5432.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataScope.test.js test/metadataCapabilities.test.js test/apiAuth.test.js test/sameOrgService.test.js test/security.test.js test/agentSameOrg.test.js test/conversationApi.test.js test/developmentJob.test.js test/jobState.test.js test/jobStore.test.js test/orchestrator.test.js test/sfFailureMessage.test.js` - PASS, 114 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 164 tests and 0 skipped.
  - Tooling/large-object/retrieval-evidence correction verification:
    - `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataCapabilities.test.js` - RED first, failed for expected missing Tooling API command builder, FlowDefinitionView `ApiName` parsing, large-object field handling, and strict retrieval evidence gaps.
    - `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataCapabilities.test.js` - PASS, 16 tests, 0 skipped.
    - `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataScope.test.js test/metadataCapabilities.test.js` - PASS, 19 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataScope.test.js test/metadataCapabilities.test.js test/apiAuth.test.js test/sameOrgService.test.js test/security.test.js test/agentSameOrg.test.js test/conversationApi.test.js test/developmentJob.test.js test/jobState.test.js test/jobStore.test.js test/orchestrator.test.js test/sfFailureMessage.test.js` - PASS, 116 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 166 tests and 0 skipped.
  - Deterministic FieldDefinition/picklist/retrieve-adapter correction verification:
    - `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataCapabilities.test.js` - RED first, failed for expected broad FieldDefinition paging, fabricated picklist values, missing PicklistValueInfo evidence, and real CLI retrieve-output adapter gaps.
    - `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataCapabilities.test.js` - PASS, 22 tests, 0 skipped.
    - `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataScope.test.js test/metadataCapabilities.test.js` - PASS, 25 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataScope.test.js test/metadataCapabilities.test.js test/apiAuth.test.js test/sameOrgService.test.js test/security.test.js test/agentSameOrg.test.js test/conversationApi.test.js test/developmentJob.test.js test/jobState.test.js test/jobStore.test.js test/orchestrator.test.js test/sfFailureMessage.test.js` - PASS, 122 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 172 tests and 0 skipped.
  - Review:
    - `inspectFlowRequirement({ requirement, orgContext })` returns deterministic Flow inspection sections for objects, fields, relationships, status candidates, flows, Apex automation, validation rules, layouts, permission sets, evidence, and ambiguities.
    - Org inspection requires a WeakSet-trusted same-org context with fresh verified org evidence, rejects production contexts, and ignores prompt/body org or target-org values.
    - Discovery uses bounded static Salesforce queries and filters to allowed metadata families before validating component names, dependency depth, and component count.
    - Targeted retrieval uses one explicit `--metadata` argument per verified component and explicit `--target-org` from the trusted org context; malformed or command-like component names reject before CLI execution.
    - Evidence records include stable unique evidence IDs, kind, applicable component/object/field identity, source org ID matching the verified org, and observed timestamp; Flow entries carry the same verified source org ID.
    - Empty verified object or relationship scope returns a material ambiguity, and planning rejects material ambiguities before source generation.
  - Correction review:
    - Discovery is operation-descriptor driven, parses realistic Salesforce query and Tooling field JSON shapes, and maps every row by the descriptor metadata family instead of ambiguous row-shape inference.
    - Field and relationship evidence comes from bounded Tooling API `FieldDefinition` results for verified Salesforce-discovered objects, including `GiftTransaction.GiftCommitmentId` to `GiftCommitment`, picklist status candidates, and verified source org IDs.
    - Every generated query includes an explicit numeric `LIMIT` no larger than the remaining component budget, oversized responses are rejected, discovery stops at budget exhaustion, and unrelated org-wide rows are excluded.
    - Retrieval success is validated from process exit, CLI status/success JSON, target-org evidence, and retrieved files before components are marked retrieved; failures return controlled non-secret inspection errors and block planning.
    - Planning requires a verified relationship connecting relevant verified candidate objects; unrelated or missing relationships produce material ambiguities.
    - Trusted org context now requires a valid fresh verification timestamp, rejects stale, future-skewed, missing, invalid, production, default-org, and prompt-controlled target contexts, and preserves Task 4 provenance checks.
  - Tooling/large-object/retrieval-evidence correction review:
    - Tooling metadata discovery uses explicit `toolingQuery` execution, which renders `sf data query --use-tooling-api --target-org VERIFIED_ALIAS --json`.
    - FlowDefinitionView parsing uses realistic `ApiName` and active-state fields instead of unsupported row assumptions, and Tooling entity discovery requests carry explicit Tooling API intent.
    - Field, relationship, and status discovery now uses bounded Tooling API `FieldDefinition` queries for verified Salesforce-discovered objects; complete describe responses are no longer treated as server-limited or rejected for having many unrelated fields.
    - Retrieval fails unless exit code, `status: 0`, verified target Org ID evidence, retrieved-file evidence, and every requested component match the verified scope.
  - Deterministic FieldDefinition/picklist/retrieve-adapter correction review:
    - Required field discovery now uses exact bounded `FieldDefinition` queries for candidate relationship and status field API names instead of relying on the first page of broad lookup/picklist results.
    - Paid and Completed values are verified only from bounded Tooling API `PicklistValueInfo` rows with object, field, value, operation, observed timestamp, and verified org provenance; missing or unusable values produce material ambiguity and skip retrieval.
    - Retrieval verification normalizes Salesforce CLI `sf project retrieve start --json` `fileResponses`/paths into component evidence, rejects empty, partial, failed, canceled, malformed, and unexpected output, and performs same-org verification before retrieval.

- Phase 1 Task 4: Enforce same-sandbox identity and permission claims
  - Implementation commit: 17f1a71dc4d746bc6093ba708a8dc934e1d506ed
  - Security correction commit: f5a00d28829b6e888b3af6aff8453bc14c693d0a
  - Final authorization correction commit: 3434f8c5776c378e54eca06bf3a53f87ab311e8a
  - Final cross-org correction commit: c1c559679e11326e48646a5f5a7f9a86371b25fe
  - Final approval-ordering correction commit: 10368e78bf5392ef674a56e5856069e8aafe1282
  - Verification date: 2026-08-02
  - Verification:
    - `cd middleware && node --import ./test/setup.js --test test/sameOrgService.test.js test/apiAuth.test.js test/security.test.js` - RED first, failed for expected missing same-org service, missing production executor preflight, and permission-claim enforcement gaps.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/sameOrgService.test.js test/orgRouting.test.js test/apiAuth.test.js test/security.test.js test/conversationApi.test.js test/agentJiraIsolation.test.js` - PASS, 47 tests, 0 skipped.
    - `sf.cmd apex run test --tests AgentControllerTest --result-format human --wait 10 --target-org $env:PHASE1_SALESFORCE_ALIAS` - PASS against explicit alias `Developer-org`, 14 tests, 0 skipped, Org Id `00Dg500000E07e9EAB`.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 108 tests and 0 skipped.
  - Security correction verification:
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/apiAuth.test.js test/sameOrgService.test.js test/security.test.js test/agentSameOrg.test.js` - RED first, failed for expected header-only authentication bypass, missing direct-path same-org resolution, incomplete identity evidence, mutable nested policy collections, malformed org ID truncation, and fabricated executor context acceptance.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/apiAuth.test.js test/sameOrgService.test.js test/security.test.js test/agentSameOrg.test.js test/orgRouting.test.js test/conversationApi.test.js test/agentJiraIsolation.test.js` - PASS, 56 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 117 tests and 0 skipped.
    - `sf.cmd apex run test --tests AgentControllerTest --result-format human --wait 10 --target-org $env:PHASE1_SALESFORCE_ALIAS` - PASS against explicit alias `Developer-org`, 14 tests, 0 skipped, Org Id `00Dg500000E07e9EAB`.
  - Final authorization correction verification:
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/apiAuth.test.js test/salesforceId.test.js test/sameOrgService.test.js test/orgRouting.test.js test/security.test.js test/agentSameOrg.test.js test/conversationApi.test.js` - RED first, failed for expected bearer-token plus role-header downgrade, missing Salesforce checksum validation, permissive org-routing ID matching, and 15/18 same-org canonicalization gaps.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/apiAuth.test.js test/salesforceId.test.js test/sameOrgService.test.js test/orgRouting.test.js test/security.test.js test/agentSameOrg.test.js test/conversationApi.test.js` - PASS, 70 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 133 tests and 0 skipped.
    - `sf.cmd apex run test --tests AgentControllerTest --result-format human --wait 10 --target-org $env:PHASE1_SALESFORCE_ALIAS` - PASS against explicit alias `Developer-org`, 14 tests, 0 skipped, Org Id `00Dg500000E07e9EAB`.
  - Final cross-org correction verification:
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/apiAuth.test.js test/agentSameOrg.test.js` - RED first, failed for expected cross-org Salesforce-chat read/mutation bypass, bearer-only list fallback, missing list claim parsing, and approval-org binding gaps.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/apiAuth.test.js test/agentSameOrg.test.js` - PASS, 21 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/apiAuth.test.js test/conversationApi.test.js test/approval.test.js test/salesforceId.test.js test/sameOrgService.test.js test/orgRouting.test.js test/security.test.js test/agentSameOrg.test.js test/agentJiraIsolation.test.js test/agentQueue.test.js test/agentQueueFallback.test.js` - PASS, 82 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 139 tests and 0 skipped.
    - `sf.cmd apex run test --tests AgentControllerTest --result-format human --wait 10 --target-org $env:PHASE1_SALESFORCE_ALIAS` - PASS against explicit alias `Developer-org`, 14 tests, 0 skipped, Org Id `00Dg500000E07e9EAB`.
  - Review:
    - `resolveSameOrg({ authenticatedOrgId, actorId })` resolves exactly one active connected registry entry matching the authenticated Salesforce org ID and rejects body/prompt/org-registry attempts to switch orgs.
    - `assertSameVerifiedOrg(orgContext, observed)` verifies organization ID, normalized instance URL, configured username, connected status, and non-production context before returning a frozen public context.
    - Salesforce Apex callouts send `X-Agent-User-Id`, `X-Agent-Org-Id`, `X-Agent-Can-Implement`, and `X-Agent-Can-Deploy`; middleware derives direct-action permissions from authenticated headers and ignores JSON-body role/org/permission claims.
    - Salesforce executor operations still require explicit org context, force `--target-org`, reject target mismatches, and block production contexts before CLI lookup.
  - Security correction review:
    - `requireApiAuth` no longer accepts Salesforce identity or permission headers as authentication; headers are parsed only after bearer-token authentication succeeds, and malformed direct Salesforce headers fail closed.
    - Direct Salesforce chat job creation resolves same-org context from authenticated `X-Agent-Org-Id`; workers re-resolve fresh trusted context before implementation, validation, or deployment execution.
    - `assertSameVerifiedOrg` requires configured and observed org ID, instance URL, username, connected status, and non-production evidence; Salesforce org IDs must be valid 15- or 18-character IDs and are not matched by prefix truncation.
    - Public org contexts are deeply frozen, and Salesforce executor operations reject structurally correct but untrusted fabricated contexts while preserving internal registry-built Jira contexts for explicitly enabled legacy Jira workflows.
  - Final authorization correction review:
    - Bearer-token API callers now receive immutable `trusted-internal-service` mode that ignores caller-supplied role headers; `salesforce-chat` job routes require `salesforce-claims` mode before read, conversation, implementation, validation, deployment, or approval authorization.
    - `X-Agent-Role` no longer grants `salesforce-chat` read, implementation, or deployment access; `canImplement` and `canDeploy` remain independent, and body-spoofed role or permission fields are ignored.
    - Shared Salesforce ID canonicalization validates exact 15- and 18-character IDs with the official checksum suffix and is used by auth claim parsing, same-org resolution, org registry matching, and Salesforce executor org checks.
  - Final cross-org correction review:
    - Salesforce-chat list, read, conversation, cancellation, approval, queue, validation, and deployment routes require canonical actor/job org equality before owner, implementation, deployment, or role authorization is evaluated.
    - The user-facing job list now parses complete Salesforce claims, rejects bearer-only or incomplete Salesforce identity headers, filters by authenticated org, and does not let query/body/role spoofing widen results.
    - New Salesforce-chat approvals are bound to the authenticated org ID; workers reject approval org mismatches, missing approval org bindings, resolved-context org mismatches, and validation target-org mismatches before Salesforce execution.
  - Final approval-ordering correction verification:
    - `cd middleware && node --import ./test/setup.js --test test/agentSameOrg.test.js test/conversationApi.test.js` - RED first, failed for expected worker `orgContext` persistence before approval rejection and `/deploy` returning 202 for missing/mismatched approval org bindings.
    - `cd middleware && node --import ./test/setup.js --test test/agentSameOrg.test.js test/conversationApi.test.js` - PASS, 25 tests, 0 skipped.
    - `cd middleware && $env:WORKSPACE_ROOT='C:\Users\ESHOP\Documents\Projects\Salesforce-AI-Agent\middleware\.tmp\providus-nexus-test-workspace'; $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --import ./test/setup.js --test test/apiAuth.test.js test/agentSameOrg.test.js test/conversationApi.test.js test/approval.test.js test/salesforceId.test.js test/sameOrgService.test.js test/orgRouting.test.js test/security.test.js test/agentJiraIsolation.test.js test/agentQueue.test.js test/agentQueueFallback.test.js` - PASS, 90 tests, 0 skipped.
    - `cd middleware && $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; node --input-type=module -e "import pg from 'pg'; const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect(); const r = await c.query('select current_database() as db, inet_server_addr() as addr, inet_server_port() as port'); console.log(JSON.stringify(r.rows[0])); await c.end();"` - PASS, connected to `providus_nexus_test` on PostgreSQL port 5432.
    - `cd middleware && $env:WORKSPACE_ROOT='C:\Users\ESHOP\Documents\Projects\Salesforce-AI-Agent\middleware\.tmp\providus-nexus-test-workspace'; $env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'; npm.cmd run check` - PASS, lint plus 147 tests and 0 skipped.
    - `sf.cmd org display --target-org $env:PHASE1_SALESFORCE_ALIAS --json` - PASS, explicit alias `Developer-org` resolved to Org Id `00Dg500000E07e9EAB`.
    - `sf.cmd apex run test --tests AgentControllerTest --result-format human --wait 10 --target-org $env:PHASE1_SALESFORCE_ALIAS` - PASS against explicit alias `Developer-org`, 14 tests, 0 skipped, Org Id `00Dg500000E07e9EAB`.
  - Final approval-ordering correction review:
    - Worker implementation, validation, and deployment resolve fresh direct Salesforce org context without persistence, validate org-bound approvals and required hashes first, then persist the safe org context only after guards pass.
    - `/api/jobs/:jobId/deploy` validates the complete org-bound deployment approval before status transition, state history append, audit/log append, org-context persistence, or queue submission.
    - `/api/jobs/:jobId/implement` and `/api/jobs/:jobId/validate` use the same org-bound approval validator before queue submission.

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

Phase 1 Task 6: Reliable same-sandbox planning inputs.

## Update Rules

- Update this file in the same commit as each implementation task.
- Record the pushed commit SHA after the commit is available; if that requires a follow-up documentation commit, record both SHAs.
- Do not mark a task complete without verification evidence.
- Record blockers factually without pasting long logs.
