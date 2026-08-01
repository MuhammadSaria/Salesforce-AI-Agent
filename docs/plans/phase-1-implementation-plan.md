# Providus Nexus Phase 1 Flow Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a direct, persistent Salesforce LWC conversation that inspects the same sandbox, produces a source-free plan, obtains separate approvals, generates bounded field/permission/Flow source, validates and mechanically corrects it, and deploys the exact Flow package inactive.

**Architecture:** Preserve the current LWC, Apex callout, Express API, BullMQ worker, Git worktree, Salesforce CLI, approval, audit, and report foundations. Replace the Jira-coupled single-response planner with a direct-chat lifecycle, a PostgreSQL-backed job repository, deterministic org inspection, a source-free architecture plan, and specialist-specific source generation. Jira remains compiled but disabled and outside Phase 1 routes, states, readiness, prompts, and UI.

**Tech Stack:** Salesforce LWC/Apex/Metadata API, Node.js 20.11+, Express 4, Zod 3, PostgreSQL with `pg`, Redis/BullMQ 5, Salesforce CLI, Git worktrees, Node test runner, ESLint, Jest for LWC.

## Global Constraints

- The LWC and all changes target the same configured development sandbox.
- Verify organization ID, instance URL, username, and environment before every Salesforce operation; never use a default org.
- Any authenticated Salesforce user may create and discuss a job.
- Implementation requires `AI_Agent_Admin`; deployment and rollback require `AI_Agent_Deploy`.
- Implementation and deployment approvals are separate and bound to immutable hashes.
- Planning contains no generated source code.
- Each specialist receives only approved, relevant context and owns every file it generates.
- Model output cannot select an org, approve work, run commands, or deploy.
- Flows deploy with `<status>Draft</status>` and are never activated by Providus Nexus.
- Mechanical correction is limited to three validation cycles.
- Up to 10 approved record mutations may execute automatically; more than 10 require preview confirmation.
- Jira, production deployment, multi-org selection, automatic Flow activation, and arbitrary model-generated commands are excluded.
- Every task uses test-first development and ends in an independently reviewable commit.
- Before Salesforce commands, set `PHASE1_SALESFORCE_ALIAS` to the verified alias from `middleware/config/org-registry.json`; the same-org verifier must prove that alias matches the hosting org ID.

---

## Planned File Structure

### New middleware files

- `middleware/src/persistence/database.js` — PostgreSQL pool and transaction boundary.
- `middleware/src/persistence/migrate.js` — applies numbered SQL migrations.
- `middleware/src/persistence/jobRepository.js` — durable Development Job repository interface.
- `middleware/migrations/001_phase1_jobs.sql` — jobs, messages, plans, approvals, events, and locks.
- `middleware/src/domain/developmentJob.js` — Phase 1 state transitions and invariants.
- `middleware/src/domain/architecturePlan.js` — source-free plan schema and approval hash projection.
- `middleware/src/domain/specialistContract.js` — specialist request/result schemas.
- `middleware/src/services/conversationService.js` — classifies and persists user turns.
- `middleware/src/services/sameOrgService.js` — resolves and verifies only the authenticated sandbox.
- `middleware/src/services/orgInspectionService.js` — deterministic Flow/object/field/automation inspection.
- `middleware/src/services/architecturePlanner.js` — produces source-free plans.
- `middleware/src/services/specialistRunner.js` — executes bounded specialists in dependency order.
- `middleware/src/specialists/objectFieldSpecialist.js` — generates missing field metadata.
- `middleware/src/specialists/securitySpecialist.js` — generates permission-set field access.
- `middleware/src/specialists/flowSpecialist.js` — generates inactive Flow metadata.
- `middleware/src/validation/sourceValidator.js` — path, ownership, completeness, secret, and source checks.
- `middleware/src/validation/flowValidator.js` — Flow structural and semantic checks.
- `middleware/src/services/componentLockService.js` — leased component locks.
- `middleware/src/services/correctionService.js` — failure classification and bounded mechanical repair.
- `middleware/test/helpers/postgres.js` — isolated PostgreSQL test transactions.
- `middleware/test/*.test.js` — focused tests listed in each task.

### Existing middleware files modified

- `middleware/package.json`, `middleware/package-lock.json`
- `middleware/docker-compose.yml`, `middleware/.env.example`, `middleware/src/config.js`
- `middleware/src/server.js`, `middleware/src/worker.js`
- `middleware/src/services/agent.js`, `middleware/src/services/jobStore.js`
- `middleware/src/services/modelExecutor.js`, `middleware/src/services/planning.js`
- `middleware/src/services/sfExecutor.js`, `middleware/src/services/runtimeHealth.js`
- `middleware/src/services/orchestrator.js`, `middleware/src/domain/specialistAgents.js`
- `middleware/src/middleware/auth.js`, `middleware/src/services/jobPresentation.js`

### Salesforce files modified

- `force-app/main/default/classes/AgentController.cls`
- `force-app/main/default/classes/AgentControllerTest.cls`
- `force-app/main/default/lwc/agentChat/agentChat.js`
- `force-app/main/default/lwc/agentChat/agentChat.html`
- `force-app/main/default/lwc/agentChat/agentChat.css`
- `force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js`
- `force-app/main/default/permissionsets/AI_Agent_User.permissionset-meta.xml`
- `force-app/main/default/permissionsets/AI_Agent_Executor.permissionset-meta.xml`

---

### Task 1: Establish the Phase 1 direct-chat state model

**Files:**
- Create: `middleware/src/domain/developmentJob.js`
- Modify: `middleware/src/domain/jobState.js`
- Modify: `middleware/src/services/jobPresentation.js`
- Test: `middleware/test/developmentJob.test.js`

**Interfaces:**
- Produces: `DEVELOPMENT_JOB_STATES`, `assertDevelopmentTransition(from, to)`, `publicDevelopmentStatus(state)`.
- Consumes: no new project interfaces.

- [ ] **Step 1: Write failing state-transition tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDevelopmentTransition, publicDevelopmentStatus } from '../src/domain/developmentJob.js';

test('direct chat reaches planning without a Jira state', () => {
  assert.doesNotThrow(() => assertDevelopmentTransition('RECEIVED', 'UNDERSTANDING'));
  assert.doesNotThrow(() => assertDevelopmentTransition('UNDERSTANDING', 'INSPECTING_ORG'));
  assert.doesNotThrow(() => assertDevelopmentTransition('INSPECTING_ORG', 'PLANNING'));
});

test('implementation cannot skip approval', () => {
  assert.throws(() => assertDevelopmentTransition('PLANNING', 'IMPLEMENTING'), /Invalid job transition/);
});

test('states have business-readable labels', () => {
  assert.equal(publicDevelopmentStatus('AWAITING_IMPLEMENTATION_APPROVAL'), 'Plan ready for review');
  assert.equal(publicDevelopmentStatus('VALIDATING'), 'Checking the solution in Salesforce');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/developmentJob.test.js`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `developmentJob.js`.

- [ ] **Step 3: Implement the state map and presentation projection**

```js
export const DEVELOPMENT_JOB_STATES = Object.freeze({
  RECEIVED: 'RECEIVED', UNDERSTANDING: 'UNDERSTANDING', AWAITING_CLARIFICATION: 'AWAITING_CLARIFICATION',
  INSPECTING_ORG: 'INSPECTING_ORG', PLANNING: 'PLANNING',
  AWAITING_IMPLEMENTATION_APPROVAL: 'AWAITING_IMPLEMENTATION_APPROVAL', IMPLEMENTING: 'IMPLEMENTING',
  WAITING_FOR_LOCK: 'WAITING_FOR_LOCK', VALIDATING: 'VALIDATING', CORRECTING: 'CORRECTING',
  AWAITING_DEPLOYMENT_APPROVAL: 'AWAITING_DEPLOYMENT_APPROVAL', DEPLOYING: 'DEPLOYING',
  COMPLETED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED'
});

const allowed = new Map([
  ['RECEIVED', ['UNDERSTANDING', 'CANCELLED']],
  ['UNDERSTANDING', ['AWAITING_CLARIFICATION', 'INSPECTING_ORG', 'FAILED', 'CANCELLED']],
  ['AWAITING_CLARIFICATION', ['UNDERSTANDING', 'CANCELLED']],
  ['INSPECTING_ORG', ['PLANNING', 'AWAITING_CLARIFICATION', 'FAILED', 'CANCELLED']],
  ['PLANNING', ['AWAITING_IMPLEMENTATION_APPROVAL', 'AWAITING_CLARIFICATION', 'FAILED', 'CANCELLED']],
  ['AWAITING_IMPLEMENTATION_APPROVAL', ['UNDERSTANDING', 'IMPLEMENTING', 'CANCELLED']],
  ['IMPLEMENTING', ['WAITING_FOR_LOCK', 'VALIDATING', 'FAILED', 'CANCELLED']],
  ['WAITING_FOR_LOCK', ['IMPLEMENTING', 'FAILED', 'CANCELLED']],
  ['VALIDATING', ['CORRECTING', 'AWAITING_DEPLOYMENT_APPROVAL', 'FAILED', 'CANCELLED']],
  ['CORRECTING', ['VALIDATING', 'AWAITING_CLARIFICATION', 'FAILED', 'CANCELLED']],
  ['AWAITING_DEPLOYMENT_APPROVAL', ['DEPLOYING', 'CANCELLED']],
  ['DEPLOYING', ['COMPLETED', 'FAILED']],
  ['COMPLETED', []], ['FAILED', ['UNDERSTANDING', 'CANCELLED']], ['CANCELLED', []]
]);
```

- [ ] **Step 4: Replace Phase 1 user-facing references to `ANALYZING_JIRA` and `AWAITING_PLAN_APPROVAL` with the new vocabulary while retaining legacy-state read compatibility**

Use `publicDevelopmentStatus()` in `jobPresentation.js`; do not delete legacy constants yet because historical job snapshots still contain them.

- [ ] **Step 5: Run focused and regression tests**

Run: `cd middleware && node --import ./test/setup.js --test test/developmentJob.test.js test/jobState.test.js test/jobPresentation.test.js`  
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add middleware/src/domain/developmentJob.js middleware/src/domain/jobState.js middleware/src/services/jobPresentation.js middleware/test/developmentJob.test.js
git commit -m "feat: add direct development job lifecycle"
```

### Task 2: Add durable PostgreSQL job persistence

**Files:**
- Create: `middleware/migrations/001_phase1_jobs.sql`
- Create: `middleware/src/persistence/database.js`
- Create: `middleware/src/persistence/migrate.js`
- Create: `middleware/src/persistence/jobRepository.js`
- Create: `middleware/test/helpers/postgres.js`
- Create: `middleware/test/jobRepositoryPostgres.test.js`
- Modify: `middleware/package.json`
- Modify: `middleware/docker-compose.yml`
- Modify: `middleware/.env.example`
- Modify: `middleware/src/config.js`

**Interfaces:**
- Produces: `createJobRepository({ pool })` with `createJob`, `getJob`, `listJobs`, `appendMessage`, `savePlan`, `appendApproval`, `transition`, `appendEvent`, and `withTransaction`.
- Produces: `databasePool()` and `migrate(pool)`.

- [ ] **Step 1: Add `pg` and refresh the lockfile**

Run: `cd middleware && npm install pg@^8.13.0`  
Expected: `package.json` and `package-lock.json` contain `pg`.

- [ ] **Step 2: Write a failing repository integration test**

```js
test('persists a job, conversation, plan, approval, and transition atomically', async () => {
  const repository = createJobRepository({ pool });
  await repository.createJob({ jobId: 'job-1', userId: '005-user', orgId: '00D-org', prompt: 'Create a Flow' });
  await repository.appendMessage('job-1', { messageId: 'm-1', role: 'user', kind: 'requirement', text: 'Create a Flow' });
  await repository.savePlan('job-1', { version: 1, planHash: 'plan-hash', scopeHash: 'scope-hash', body: { expectedOutcome: 'Inactive Flow' } });
  await repository.appendApproval('job-1', { approvalId: 'a-1', type: 'IMPLEMENTATION', decision: 'APPROVED', actorId: '005-admin', planHash: 'plan-hash', scopeHash: 'scope-hash' });
  await repository.transition('job-1', 'AWAITING_IMPLEMENTATION_APPROVAL', 'IMPLEMENTING', { actorId: '005-admin' });
  const job = await repository.getJob('job-1');
  assert.equal(job.status, 'IMPLEMENTING');
  assert.equal(job.messages[0].text, 'Create a Flow');
  assert.equal(job.plans[0].planHash, 'plan-hash');
  assert.equal(job.approvals[0].decision, 'APPROVED');
});
```

- [ ] **Step 3: Run the repository test and verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/jobRepositoryPostgres.test.js`  
Expected: FAIL because migration and repository modules do not exist.

- [ ] **Step 4: Create normalized tables and immutable constraints**

The migration must create `development_jobs`, `job_messages`, `job_plans`, `job_approvals`, `job_events`, and `component_locks`. Use primary keys for IDs, foreign keys with `ON DELETE RESTRICT`, `jsonb` for bounded structured bodies, unique `(job_id, version)` plans, and append-only application methods for approvals/events.

```sql
CREATE TABLE development_jobs (
  job_id text PRIMARY KEY,
  user_id text NOT NULL,
  org_id text NOT NULL,
  prompt text NOT NULL,
  status text NOT NULL,
  current_plan_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 5: Implement parameterized repository methods and transactional transition checks**

```js
export function createJobRepository({ pool }) {
  return {
    async withTransaction(work) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async getJob(jobId) { return hydrateJob(pool, jobId); }
  };
}
```

- [ ] **Step 6: Add PostgreSQL to Compose and configuration**

Set `DATABASE_URL=postgres://providus:providus@postgres:5432/providus_nexus` in Compose. Keep secrets overrideable through environment variables and do not log the URL.

- [ ] **Step 7: Run migrations and tests**

Run: `cd middleware && docker compose up -d postgres && npm run migrate && node --import ./test/setup.js --test test/jobRepositoryPostgres.test.js`  
Expected: migration succeeds and test PASS.

- [ ] **Step 8: Commit**

```bash
git add middleware/migrations middleware/src/persistence middleware/test/helpers/postgres.js middleware/test/jobRepositoryPostgres.test.js middleware/package.json middleware/package-lock.json middleware/docker-compose.yml middleware/.env.example middleware/src/config.js
git commit -m "feat: persist development jobs in postgres"
```

### Task 3: Introduce direct conversation APIs and isolate Jira

**Files:**
- Create: `middleware/src/services/conversationService.js`
- Create: `middleware/test/conversationApi.test.js`
- Modify: `middleware/src/server.js`
- Modify: `middleware/src/worker.js`
- Modify: `middleware/src/services/runtimeHealth.js`
- Modify: `middleware/src/config.js`
- Test: `middleware/test/runtimeHealth.test.js`

**Interfaces:**
- Produces: `conversationService({ repository, enqueue })` with `start`, `append`, and `cancel`.
- Adds: `POST /api/jobs`, `POST /api/jobs/:jobId/messages`, `POST /api/jobs/:jobId/cancel`.
- Keeps Jira endpoints registered only when `JIRA_ENABLED=true`; default is `false`.

- [ ] **Step 1: Write failing API tests**

```js
test('any authenticated Salesforce user can start and continue their own job', async () => {
  const created = await request(app).post('/api/jobs').set(viewerHeaders).send({ prompt: 'Create a recurring donation installment Flow' });
  assert.equal(created.status, 201);
  const replied = await request(app).post(`/api/jobs/${created.body.jobId}/messages`).set(viewerHeaders).send({ text: 'Only completed donations count.' });
  assert.equal(replied.status, 202);
});

test('Phase 1 readiness does not require Jira', async () => {
  const readiness = await runtimeReadiness({ jiraEnabled: false });
  assert.equal(readiness.checks.jira, undefined);
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `cd middleware && node --import ./test/setup.js --test test/conversationApi.test.js test/runtimeHealth.test.js`  
Expected: `/messages` is 404 or role-blocked and readiness still includes Jira.

- [ ] **Step 3: Implement a single message endpoint for requirement, clarification, question, and revision turns**

```js
app.post('/api/jobs/:jobId/messages', jobRoute(async (req, res, job) => {
  const text = sanitizeUntrustedText(req.body?.text, 4000).trim();
  if (!text) return res.status(422).json({ error: { code: 'MESSAGE_REQUIRED', message: 'Enter a message.' } });
  const outcome = await conversationService.append({ job, actor: req.actor, text });
  res.status(202).json(outcome);
}));
```

Allow the job owner to converse regardless of implementation role. Preserve owner/admin access isolation. Approval routes remain role-gated.

- [ ] **Step 4: Disable Jira startup, webhook, poller, readiness, prompt fields, and worker actions unless `JIRA_ENABLED=true`**

Do not delete historical Jira services. Ensure a new manual job has `source: 'salesforce-chat'`, no `jiraIssueKey`, and no transition through a Jira state.

- [ ] **Step 5: Run focused tests and the API security regressions**

Run: `cd middleware && node --import ./test/setup.js --test test/conversationApi.test.js test/apiAuth.test.js test/security.test.js test/runtimeHealth.test.js`  
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add middleware/src/services/conversationService.js middleware/src/server.js middleware/src/worker.js middleware/src/services/runtimeHealth.js middleware/src/config.js middleware/test/conversationApi.test.js middleware/test/runtimeHealth.test.js
git commit -m "feat: add direct Salesforce conversation lifecycle"
```

### Task 4: Enforce same-sandbox identity and permission claims

**Files:**
- Create: `middleware/src/services/sameOrgService.js`
- Create: `middleware/test/sameOrgService.test.js`
- Modify: `middleware/src/middleware/auth.js`
- Modify: `middleware/src/services/orgRegistry.js`
- Modify: `middleware/src/services/sfExecutor.js`
- Modify: `force-app/main/default/classes/AgentController.cls`
- Modify: `force-app/main/default/classes/AgentControllerTest.cls`

**Interfaces:**
- Produces: `resolveSameOrg({ authenticatedOrgId, actorId })` and `assertSameVerifiedOrg(orgContext, observed)`.
- Apex headers: `X-Agent-User-Id`, `X-Agent-Org-Id`, `X-Agent-Can-Implement`, `X-Agent-Can-Deploy`.

- [ ] **Step 1: Write failing org-isolation tests**

```js
test('resolves exactly the registry entry matching the authenticated Salesforce org', async () => {
  const org = await resolveSameOrg({ authenticatedOrgId: '00D-SAPA', actorId: '005-user' });
  assert.equal(org.expectedOrgId, '00D-SAPA');
});

test('rejects another registry org even when supplied by prompt or request body', async () => {
  await assert.rejects(() => resolveSameOrg({ authenticatedOrgId: '00D-SAPA', requestedOrgId: '00D-OTHER' }), /same Salesforce sandbox/);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/sameOrgService.test.js`  
Expected: FAIL because same-org service does not exist.

- [ ] **Step 3: Implement exact-org resolution and remove Phase 1 org selection**

The service must find one active registry entry whose `expectedOrgId` equals `X-Agent-Org-Id`, verify CLI `organizationId`, normalized instance URL, configured username, connected status, and non-production environment, then return a frozen public context.

- [ ] **Step 4: Add Apex permission headers using custom permissions**

```apex
request.setHeader('X-Agent-User-Id', UserInfo.getUserId());
request.setHeader('X-Agent-Org-Id', UserInfo.getOrganizationId());
request.setHeader('X-Agent-Can-Implement', String.valueOf(FeatureManagement.checkPermission('AI_Agent_Admin')));
request.setHeader('X-Agent-Can-Deploy', String.valueOf(FeatureManagement.checkPermission('AI_Agent_Deploy')));
```

Middleware must treat these as signed-callout claims under the existing API authentication boundary and never accept equivalent values from JSON bodies.

- [ ] **Step 5: Make every Salesforce executor call require an explicit verified context**

Reject missing `--target-org`, production contexts, org-ID mismatch, and default-org lookup.

- [ ] **Step 6: Run middleware and Apex tests**

Run: `cd middleware && node --import ./test/setup.js --test test/sameOrgService.test.js test/orgRegistry.test.js test/security.test.js`  
Run: `sf apex run test --tests AgentControllerTest --result-format human --wait 10 --target-org "$PHASE1_SALESFORCE_ALIAS"`  
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add middleware/src/services/sameOrgService.js middleware/src/middleware/auth.js middleware/src/services/orgRegistry.js middleware/src/services/sfExecutor.js middleware/test/sameOrgService.test.js force-app/main/default/classes/AgentController.cls force-app/main/default/classes/AgentControllerTest.cls
git commit -m "feat: bind agent actions to the hosting sandbox"
```

### Task 5: Build deterministic org inspection for Flow work

**Files:**
- Create: `middleware/src/services/orgInspectionService.js`
- Create: `middleware/test/orgInspectionService.test.js`
- Modify: `middleware/src/services/sfExecutor.js`
- Modify: `middleware/src/services/planning.js`

**Interfaces:**
- Produces: `inspectFlowRequirement({ requirement, orgContext }) -> FlowInspection`.
- `FlowInspection` contains `objects`, `fields`, `relationships`, `statusCandidates`, `flows`, `apexAutomation`, `validationRules`, `layouts`, `permissionSets`, `evidence`, and `ambiguities`.

- [ ] **Step 1: Write failing inspection tests with mocked Salesforce CLI responses**

```js
test('inspection finds Donation dependencies instead of returning an empty scope', async () => {
  const inspection = await inspectFlowRequirement({ requirement, orgContext }, { sf: fakeSf });
  assert.deepEqual(inspection.objects.map(x => x.apiName), ['GiftCommitment', 'GiftTransaction']);
  assert.equal(inspection.relationships[0].fieldApiName, 'GiftCommitmentId');
  assert.ok(inspection.flows.every(flow => flow.sourceOrgId === orgContext.expectedOrgId));
  assert.ok(inspection.evidence.length > 0);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js`  
Expected: FAIL because `inspectFlowRequirement` is missing.

- [ ] **Step 3: Implement bounded discovery and targeted retrieval**

Use Tooling/Metadata queries and `sfExecutor.retrieveMetadata({ components: inspection.componentKeys, targetOrg: orgContext.salesforceAlias })`; the executor must render an explicit `sf project retrieve start` command with one `--metadata` argument per verified component and `--target-org orgContext.salesforceAlias`. Do not send unrestricted org metadata to the model. Limit results using `MAX_METADATA_COMPONENTS`, dependency depth, and relevant metadata families.

- [ ] **Step 4: Make evidence addressable**

```js
evidence.push({
  evidenceId: `field:${objectApiName}.${fieldApiName}`,
  kind: 'FIELD', objectApiName, fieldApiName,
  sourceOrgId: orgContext.expectedOrgId,
  observedAt: clock().toISOString()
});
```

- [ ] **Step 5: Block planning when no verified object/relationship candidate exists**

Return material ambiguity such as `Confirm which object represents the generated Donation` rather than allowing an empty scope into source generation.

- [ ] **Step 6: Run focused and metadata-scope regressions**

Run: `cd middleware && node --import ./test/setup.js --test test/orgInspectionService.test.js test/metadataScope.test.js test/metadataCapabilities.test.js`  
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add middleware/src/services/orgInspectionService.js middleware/src/services/sfExecutor.js middleware/src/services/planning.js middleware/test/orgInspectionService.test.js
git commit -m "feat: inspect flow dependencies before planning"
```

### Task 6: Separate source-free architecture planning from source generation

**Files:**
- Create: `middleware/src/domain/architecturePlan.js`
- Create: `middleware/src/services/architecturePlanner.js`
- Create: `middleware/test/architecturePlanner.test.js`
- Modify: `middleware/src/services/modelExecutor.js`
- Modify: `middleware/src/domain/planActionability.js`
- Modify: `middleware/src/services/agent.js`

**Interfaces:**
- Produces: `ARCHITECTURE_PLAN_SCHEMA` and `createArchitecturePlan({ requirement, inspection, answers })`.
- Architecture plans contain component intents, not `content`, `fileOperations`, XML, JavaScript, Apex, or shell commands.

- [ ] **Step 1: Write failing schema and planner tests**

```js
test('architecture plan contains behavior and components but no source', async () => {
  const plan = await createArchitecturePlan({ requirement, inspection, answers }, { modelRunner });
  assert.equal(plan.components[0].metadataType, 'CustomField');
  assert.equal(plan.components.at(-1).metadataType, 'Flow');
  assert.equal(JSON.stringify(plan).includes('<Flow'), false);
  assert.equal('fileOperations' in plan, false);
});

test('paid-status ambiguity returns clarification rather than assumptions', async () => {
  await assert.rejects(() => createArchitecturePlan({ requirement, inspection: ambiguousInspection, answers: [] }), error => error.code === 'MATERIAL_CLARIFICATION_REQUIRED');
});
```

- [ ] **Step 2: Verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/architecturePlanner.test.js`  
Expected: FAIL because the source-free schema is absent.

- [ ] **Step 3: Define the exact plan contract**

```js
export const ARCHITECTURE_PLAN_SCHEMA = z.object({
  requirement: z.string().min(1).max(8000),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(25),
  assumptions: z.array(z.string().min(1).max(1000)).max(20),
  evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  components: z.array(z.object({ operation: z.enum(['create', 'modify', 'delete']), metadataType: z.string(), apiName: z.string(), owner: z.string(), reason: z.string() })).min(1).max(50),
  expectedBehavior: z.array(z.string().min(1).max(1000)).min(1).max(30),
  testingStrategy: z.array(z.string().min(1).max(1000)).min(1).max(30),
  risks: z.array(z.string().min(1).max(1000)).max(30),
  rollbackStrategy: z.string().min(1).max(2000)
}).strict();
```

- [ ] **Step 4: Replace `enrichPlanWithModel` in Phase 1 analysis with `createArchitecturePlan`**

Keep legacy export compatibility for historical/Jira tests, but new direct jobs must never ask one model response for plan plus complete files.

- [ ] **Step 5: Bind implementation approval to `planHash`, `scopeHash`, and org ID**

Reject approval when evidence is empty, components are empty, current plan version differs, or the caller lacks implementation permission.

- [ ] **Step 6: Run planner, actionability, approval, and agent tests**

Run: `cd middleware && node --import ./test/setup.js --test test/architecturePlanner.test.js test/planActionability.test.js test/approval.test.js test/agentClarificationEvidence.test.js`  
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add middleware/src/domain/architecturePlan.js middleware/src/services/architecturePlanner.js middleware/src/services/modelExecutor.js middleware/src/domain/planActionability.js middleware/src/services/agent.js middleware/test/architecturePlanner.test.js
git commit -m "refactor: separate architecture planning from source generation"
```

### Task 7: Define and execute real bounded specialist contracts

**Files:**
- Create: `middleware/src/domain/specialistContract.js`
- Create: `middleware/src/services/specialistRunner.js`
- Create: `middleware/test/specialistRunner.test.js`
- Modify: `middleware/src/domain/specialistAgents.js`
- Modify: `middleware/src/services/orchestrator.js`

**Interfaces:**
- Produces: `SPECIALIST_REQUEST_SCHEMA`, `SPECIALIST_RESULT_SCHEMA`, and `runSpecialists({ job, plan, inspection, workspace })`.
- Specialist result contains `operations`, `dependencies`, `risks`, `verification`, and `status`.

- [ ] **Step 1: Write failing ownership and dependency tests**

```js
test('runs field before flow and gives each specialist only owned metadata', async () => {
  const result = await runSpecialists({ job, plan, inspection, workspace }, { runners });
  assert.deepEqual(result.executionOrder, ['OBJECT_FIELD', 'SECURITY_PERMISSIONS', 'FLOW']);
  assert.ok(runners.FLOW.calls[0].approvedComponents.every(x => x.owner === 'FLOW'));
});

test('rejects a Flow specialist result that writes a permission set', async () => {
  await assert.rejects(() => runSpecialists(input, { runners: crossBoundaryRunner }), /specialist ownership/);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/specialistRunner.test.js`  
Expected: FAIL because specialist runner is absent.

- [ ] **Step 3: Implement strict specialist request/result schemas**

```js
const operation = z.object({
  operation: z.enum(['create', 'modify', 'delete']),
  path: z.string().min(1).max(500),
  content: z.string().max(500000),
  metadataType: z.string().min(1).max(100),
  apiName: z.string().min(1).max(255),
  reason: z.string().min(1).max(1000)
}).strict();
```

- [ ] **Step 4: Run specialists in topological order and persist each result separately**

Do not concatenate specialist prompts. A blocked specialist must return `status: 'BLOCKED'` with a material question; it must not fabricate a file.

- [ ] **Step 5: Run tests**

Run: `cd middleware && node --import ./test/setup.js --test test/specialistRunner.test.js test/orchestrator.test.js test/specialistAgents.test.js`  
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add middleware/src/domain/specialistContract.js middleware/src/services/specialistRunner.js middleware/src/domain/specialistAgents.js middleware/src/services/orchestrator.js middleware/test/specialistRunner.test.js
git commit -m "feat: execute bounded Salesforce specialists"
```

### Task 8: Implement field, security, and inactive Flow specialists

**Files:**
- Create: `middleware/src/specialists/objectFieldSpecialist.js`
- Create: `middleware/src/specialists/securitySpecialist.js`
- Create: `middleware/src/specialists/flowSpecialist.js`
- Create: `middleware/test/flowVerticalSpecialists.test.js`
- Modify: `middleware/src/services/modelExecutor.js`

**Interfaces:**
- Produces: `generateObjectFieldSource(request)`, `generateSecuritySource(request)`, `generateFlowSource(request)`.
- All return `SPECIALIST_RESULT_SCHEMA` values.

- [ ] **Step 1: Write failing recurring-donation generation tests**

```js
test('generates a number field, permission access, and inactive record-triggered Flow', async () => {
  const field = await generateObjectFieldSource(request, { modelRunner });
  const security = await generateSecuritySource({ ...request, dependencies: field.operations }, { modelRunner });
  const flow = await generateFlowSource({ ...request, dependencies: [...field.operations, ...security.operations] }, { modelRunner });
  assert.match(field.operations[0].content, /<type>Number<\/type>/);
  assert.match(security.operations[0].content, /<readable>true<\/readable>/);
  assert.match(flow.operations[0].content, /<status>Draft<\/status>/);
  assert.doesNotMatch(flow.operations[0].content, /<status>Active<\/status>/);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/flowVerticalSpecialists.test.js`  
Expected: FAIL because specialist modules do not exist.

- [ ] **Step 3: Implement one structured model call per specialist**

Each prompt must contain the approved component intents, relevant retrieved source, confirmed API names, and dependent operations. Require complete source documents. Reject paths or component names not present in the approved scope.

- [ ] **Step 4: Enforce recurring-donation semantics before accepting the Flow result**

The Flow must handle create-as-completed and transition-to-completed, ignore already numbered records, scope the highest-number query to the same parent, assign 1 when none exists, and retain numbers after reversal. It must not renumber historical records.

- [ ] **Step 5: Record the concurrency limitation in the plan and report**

If strict uniqueness is requested, return a material scope-change question proposing locking-capable Apex; do not silently claim Flow guarantees concurrency uniqueness.

- [ ] **Step 6: Run tests**

Run: `cd middleware && node --import ./test/setup.js --test test/flowVerticalSpecialists.test.js test/modelExecutor.test.js`  
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add middleware/src/specialists middleware/src/services/modelExecutor.js middleware/test/flowVerticalSpecialists.test.js
git commit -m "feat: generate bounded inactive Flow solutions"
```

### Task 9: Validate source before writing or Salesforce validation

**Files:**
- Create: `middleware/src/validation/sourceValidator.js`
- Create: `middleware/src/validation/flowValidator.js`
- Create: `middleware/test/sourceValidator.test.js`
- Create: `middleware/test/flowValidator.test.js`
- Modify: `middleware/src/services/agent.js`

**Interfaces:**
- Produces: `validateSpecialistOperations({ operations, plan, ownership })`.
- Produces: `validateFlowSource({ content, approvedBehavior, inspection })`.

- [ ] **Step 1: Write failing rejection tests**

```js
test('rejects active Flow source', () => {
  assert.throws(() => validateFlowSource({ content: activeFlow, approvedBehavior, inspection }), error => error.code === 'FLOW_MUST_BE_INACTIVE');
});

test('rejects partial XML and cross-owner paths', () => {
  assert.throws(() => validateSpecialistOperations({ operations: partialOrCrossOwned, plan, ownership }), /complete deployable source|ownership/);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/sourceValidator.test.js test/flowValidator.test.js`  
Expected: FAIL because validators are missing.

- [ ] **Step 3: Implement source integrity checks**

Validate normalized paths, one owner, approved component mapping, maximum bytes, full XML parse, source-format root element, secret patterns, and absence of shell/script payloads.

- [ ] **Step 4: Implement Flow structural and semantic checks**

Require top-level label, API version, process type, start element, executable connection, valid references, explicit Draft status, correct object, completed-status gate, same-parent highest-number lookup, non-overwrite rule, and assignment.

- [ ] **Step 5: Insert validators before `writeMetadataFile` in implementation**

No specialist bytes reach the worktree until their complete combined result passes.

- [ ] **Step 6: Run focused and regression tests**

Run: `cd middleware && node --import ./test/setup.js --test test/sourceValidator.test.js test/flowValidator.test.js test/flowSourceValidation.test.js test/metadataCapabilities.test.js`  
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add middleware/src/validation middleware/src/services/agent.js middleware/test/sourceValidator.test.js middleware/test/flowValidator.test.js
git commit -m "feat: validate specialist source before writes"
```

### Task 10: Add component locks and immutable implementation baselines

**Files:**
- Create: `middleware/src/services/componentLockService.js`
- Create: `middleware/test/componentLockService.test.js`
- Modify: `middleware/src/services/jobWorkspace.js`
- Modify: `middleware/src/services/gitExecutor.js`
- Modify: `middleware/src/services/agent.js`

**Interfaces:**
- Produces: `acquireComponentLocks({ jobId, componentKeys, leaseSeconds })`, `renewComponentLocks`, `releaseComponentLocks`.
- Component key format: `${metadataType}:${apiName}`.

- [ ] **Step 1: Write failing lock tests**

```js
test('allows unrelated jobs and queues conflicting components', async () => {
  await locks.acquireComponentLocks({ jobId: 'a', componentKeys: ['Flow:RD_Installment'], leaseSeconds: 60 });
  await assert.doesNotReject(() => locks.acquireComponentLocks({ jobId: 'b', componentKeys: ['Flow:Other'], leaseSeconds: 60 }));
  await assert.rejects(() => locks.acquireComponentLocks({ jobId: 'c', componentKeys: ['Flow:RD_Installment'], leaseSeconds: 60 }), error => error.code === 'COMPONENT_LOCKED');
});
```

- [ ] **Step 2: Verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/componentLockService.test.js`  
Expected: FAIL because lock service is missing.

- [ ] **Step 3: Implement transactional leased locks in PostgreSQL**

Use `INSERT ... ON CONFLICT` with expiration checks. A worker heartbeat renews its own locks. Another job may acquire only expired leases.

- [ ] **Step 4: Capture the exact affected metadata baseline before generating source**

Create the worktree, retrieve affected metadata, commit the baseline, and persist `baselineCommit`, per-file hashes, component keys, and org ID before writes.

- [ ] **Step 5: Release locks in `finally` and recover expired leases**

Cancellation, failure, worker crash, and successful completion must not leave permanent locks.

- [ ] **Step 6: Run tests**

Run: `cd middleware && node --import ./test/setup.js --test test/componentLockService.test.js test/gitExecutor.test.js test/sourceHash.test.js`  
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add middleware/src/services/componentLockService.js middleware/src/services/jobWorkspace.js middleware/src/services/gitExecutor.js middleware/src/services/agent.js middleware/test/componentLockService.test.js
git commit -m "feat: isolate jobs with component leases and baselines"
```

### Task 11: Add bounded validation correction

**Files:**
- Create: `middleware/src/services/correctionService.js`
- Create: `middleware/test/correctionService.test.js`
- Modify: `middleware/src/services/correctionRouting.js`
- Modify: `middleware/src/services/agent.js`
- Modify: `middleware/src/domain/developmentJob.js`

**Interfaces:**
- Produces: `classifyValidationFailure(failure) -> MECHANICAL | MATERIAL | INFRASTRUCTURE`.
- Produces: `correctMechanicalFailure({ job, failure, owner, attempt })`.

- [ ] **Step 1: Write failing classification and retry-limit tests**

```js
test('routes malformed Flow XML to its owner without changing approved scope', () => {
  assert.equal(classifyValidationFailure(flowParseFailure), 'MECHANICAL');
});

test('routes a missing business field to replanning', () => {
  assert.equal(classifyValidationFailure(unapprovedFieldFailure), 'MATERIAL');
});

test('stops after three mechanical correction cycles', async () => {
  await assert.rejects(() => correctMechanicalFailure({ job: { correctionAttempt: 3 }, failure, owner: 'FLOW', attempt: 4 }), error => error.code === 'CORRECTION_LIMIT_REACHED');
});
```

- [ ] **Step 2: Verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/correctionService.test.js`  
Expected: FAIL because service is missing.

- [ ] **Step 3: Implement evidence-based classification**

Mechanical failures include XML structure, element order, missing manifest entry, and compile syntax within approved files. Material failures include new components, changed business behavior, data/security expansion, or unrelated dependencies. Timeouts and service unavailability are infrastructure failures.

- [ ] **Step 4: Regenerate only the owning specialist's failed files**

Supply the safe validation error, original approved behavior, current complete file, and file ownership. Re-run deterministic validators and confirm the plan/scope hashes remain unchanged.

- [ ] **Step 5: Run tests**

Run: `cd middleware && node --import ./test/setup.js --test test/correctionService.test.js test/correctionRouting.test.js test/validationFailure.test.js`  
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add middleware/src/services/correctionService.js middleware/src/services/correctionRouting.js middleware/src/services/agent.js middleware/src/domain/developmentJob.js middleware/test/correctionService.test.js
git commit -m "feat: add bounded specialist validation repair"
```

### Task 12: Enforce exact validated deployment and data-operation limits

**Files:**
- Create: `middleware/test/phase1Deployment.test.js`
- Modify: `middleware/src/services/agent.js`
- Modify: `middleware/src/services/sfExecutor.js`
- Modify: `middleware/src/server.js`
- Modify: `middleware/src/domain/approval.js`
- Modify: `middleware/src/services/implementationReport.js`

**Interfaces:**
- Deployment approval projection: `validationId`, `sourceHash`, `packageHash`, `commitHash`, `orgId`, `expiresAt`.
- Data preview projection: `operation`, `objectApiName`, `filterOrIds`, `estimatedCount`, `beforeValuesHash`.

- [ ] **Step 1: Write failing deployment/data tests**

```js
test('deployment rejects changed source after validation', async () => {
  await assert.rejects(() => deployValidatedJob({ ...job, currentSourceHash: 'changed' }), error => error.code === 'STALE_VALIDATION');
});

test('deployment rejects an Active Flow even after validation', async () => {
  await assert.rejects(() => deployValidatedJob(activeFlowJob), error => error.code === 'FLOW_MUST_BE_INACTIVE');
});

test('more than ten record mutations require preview confirmation', () => {
  assert.throws(() => assertDataExecutionApproved({ estimatedCount: 11, previewApproval: null }), error => error.code === 'DATA_PREVIEW_APPROVAL_REQUIRED');
});
```

- [ ] **Step 2: Verify failure**

Run: `cd middleware && node --import ./test/setup.js --test test/phase1Deployment.test.js`  
Expected: at least the inactive Flow and data-preview cases FAIL.

- [ ] **Step 3: Recalculate all deployment guards immediately before CLI execution**

Require the exact org, validation ID, source hash, package hash, commit hash, clean worktree, unexpired validation, and approved deployment record. Parse every Flow in the package and reject non-Draft status.

- [ ] **Step 4: Add the data preview confirmation route**

Add `POST /api/jobs/:jobId/approve-data-preview`, restricted to implementation-authorized users and bound to operation hash plus estimated count. Do not combine this with deployment approval.

- [ ] **Step 5: Include inactive status, validation evidence, record effects, and concurrency risk in the implementation report**

The report must say deployed, not activated. It must not claim functional record-trigger execution for an inactive Flow.

- [ ] **Step 6: Run deployment, approval, data-policy, and report tests**

Run: `cd middleware && node --import ./test/setup.js --test test/phase1Deployment.test.js test/deploymentHistory.test.js test/approval.test.js test/recordDeletion.test.js test/implementationReport.test.js`  
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add middleware/src/services/agent.js middleware/src/services/sfExecutor.js middleware/src/server.js middleware/src/domain/approval.js middleware/src/services/implementationReport.js middleware/test/phase1Deployment.test.js
git commit -m "feat: deploy only approved inactive validated source"
```

### Task 13: Convert the LWC into the persistent conversation workspace

**Files:**
- Modify: `force-app/main/default/classes/AgentController.cls`
- Modify: `force-app/main/default/classes/AgentControllerTest.cls`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.js`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.html`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.css`
- Modify: `force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js`
- Modify: `force-app/main/default/permissionsets/AI_Agent_User.permissionset-meta.xml`
- Modify: `force-app/main/default/permissionsets/AI_Agent_Executor.permissionset-meta.xml`

**Interfaces:**
- Apex: `sendMessage(String jobId, String text)`, `createJob(String prompt)`, `getJobs()`, `getJob(String jobId)`, `performAction(String jobId, String action, String comments)`.
- LWC state: `jobs`, `selectedJob`, `messages`, `draftMessage`, `isSending`, `canImplement`, `canDeploy`.

- [ ] **Step 1: Write failing Jest tests for the approved UI behavior**

```js
it('lets an ordinary user converse but hides approval controls', async () => {
  getJob.mockResolvedValue(JSON.stringify({ job: { canImplement: false, canDeploy: false, conversation: [] } }));
  const element = createAgentChat();
  await flushPromises();
  expect(element.shadowRoot.querySelector('[data-id="message-input"]')).not.toBeNull();
  expect(element.shadowRoot.querySelector('[data-id="approve-implementation"]')).toBeNull();
});

it('shows inactive deployment wording after success', async () => {
  const element = createAgentChatWithJob({ status: 'COMPLETED', flowStatus: 'Draft' });
  await flushPromises();
  expect(element.shadowRoot.textContent).toContain('deployed inactive');
  expect(element.shadowRoot.textContent).not.toContain('activated');
});
```

- [ ] **Step 2: Run Jest and verify failure**

Run: `npm test -- --runTestsByPath force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js`  
Expected: FAIL because the single-message workspace and permission-based controls are absent.

- [ ] **Step 3: Add `sendMessage` to Apex and route it to `/api/jobs/:jobId/messages`**

Validate blank/oversized input, encode the job ID with the existing safe path helper, and use the existing Named Credential callout.

- [ ] **Step 4: Refactor LWC state around conversations rather than Jira/job operations**

Render the conversation sidebar, fixed sandbox header, chat timeline, plan card, progress card, permission-gated approvals, result/report card, and message composer. Retain accessible labels, keyboard behavior, busy states, and safe error messages.

- [ ] **Step 5: Add Apex tests for headers, message route, and permission claims**

Use `HttpCalloutMock` to assert request method, endpoint, body, user/org headers, and custom-permission claim behavior.

- [ ] **Step 6: Run Jest and Apex tests**

Run: `npm test -- --runTestsByPath force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js`  
Run: `sf apex run test --tests AgentControllerTest --result-format human --wait 10 --target-org "$PHASE1_SALESFORCE_ALIAS"`  
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add force-app/main/default/classes/AgentController.cls force-app/main/default/classes/AgentControllerTest.cls force-app/main/default/lwc/agentChat force-app/main/default/permissionsets/AI_Agent_User.permissionset-meta.xml force-app/main/default/permissionsets/AI_Agent_Executor.permissionset-meta.xml
git commit -m "feat: make Providus Nexus a persistent chatbot"
```

### Task 14: Prove the recurring-donation vertical slice and update current-system documentation

**Files:**
- Create: `middleware/test/recurringDonationVerticalSlice.test.js`
- Create: `middleware/test/fixtures/recurring-donation-inspection.json`
- Modify: `docs/CURRENT_SYSTEM.md`
- Modify: `docs/SETUP.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/API.md`
- Modify: `docs/MULTI_AGENT_ARCHITECTURE.md`
- Modify: `middleware/docker-compose.yml`

**Interfaces:**
- Consumes all Phase 1 interfaces from Tasks 1–13.
- Produces one executable acceptance test and authoritative operating documentation.

- [ ] **Step 1: Write the failing end-to-end acceptance test**

```js
test('direct recurring-donation request reaches inactive sandbox deployment truthfully', async () => {
  const job = await harness.createJob('Number each completed Donation for its Recurring Donation.');
  await harness.answerMaterialQuestions(job.jobId, { qualifyingStatus: 'Completed', reversalPolicy: 'retain', numberingRule: 'highest-plus-one' });
  const plan = await harness.waitFor(job.jobId, 'AWAITING_IMPLEMENTATION_APPROVAL');
  assert.deepEqual(plan.components.map(x => x.metadataType), ['CustomField', 'PermissionSet', 'Flow']);
  await harness.approveImplementation(job.jobId);
  const validated = await harness.waitFor(job.jobId, 'AWAITING_DEPLOYMENT_APPROVAL');
  assert.equal(validated.validation.status, 'SUCCEEDED');
  assert.match(validated.generatedFlow, /<status>Draft<\/status>/);
  await harness.approveDeployment(job.jobId);
  const completed = await harness.waitFor(job.jobId, 'COMPLETED');
  assert.equal(completed.deployment.activated, false);
  assert.equal(completed.jira, undefined);
  assert.ok(completed.reportId);
  assert.ok(completed.baselineCommit);
});
```

- [ ] **Step 2: Run the acceptance test and verify failure before final integration wiring**

Run: `cd middleware && node --import ./test/setup.js --test test/recurringDonationVerticalSlice.test.js`  
Expected: FAIL at the first incomplete integration seam rather than pass with a no-change result.

- [ ] **Step 3: Wire Phase 1 services through dependency injection in `server.js` and `worker.js`**

Use the PostgreSQL repository, direct conversation service, same-org verifier, inspector, architecture planner, specialist runner, validators, lock service, correction service, and guarded deployer. Do not add compatibility fallbacks that convert missing source into completion.

- [ ] **Step 4: Make the acceptance test pass**

Run: `cd middleware && node --import ./test/setup.js --test test/recurringDonationVerticalSlice.test.js`  
Expected: PASS with real generated source fixtures, validation evidence, inactive deployment evidence, no Jira fields, report ID, and baseline commit.

- [ ] **Step 5: Rewrite authoritative documentation for Phase 1**

Document exact environment variables, migration command, Redis/PostgreSQL startup, worker startup, same-org registry configuration, custom permissions, Salesforce Named Credential, LWC deployment, test commands, inactive Flow rule, approval model, record-mutation threshold, troubleshooting, and the disabled Jira flag.

- [ ] **Step 6: Run the complete verification suite**

Run: `cd middleware && npm run check`  
Expected: ESLint PASS and all middleware tests PASS.

Run: `npm test -- --runInBand`  
Expected: all LWC Jest tests PASS.

Run: `sf project deploy start --dry-run --source-dir force-app --test-level RunSpecifiedTests --tests AgentControllerTest --target-org "$PHASE1_SALESFORCE_ALIAS" --wait 30`  
Expected: dry-run succeeds; no Flow generated by the acceptance job has Active status.

- [ ] **Step 7: Inspect the final diff for scope and secrets**

Run: `git status --short && git diff --check && rg -n "(<status>Active</status>|GEMINI_API_KEY=.+|MIDDLEWARE_API_TOKEN=.+|JIRA_ENABLED=true)" middleware force-app docs`  
Expected: clean diff checks; no committed secret values; no Phase 1-generated active Flow; Jira not enabled by default.

- [ ] **Step 8: Commit**

```bash
git add middleware/test/recurringDonationVerticalSlice.test.js middleware/test/fixtures/recurring-donation-inspection.json middleware/src/server.js middleware/src/worker.js middleware/docker-compose.yml docs/CURRENT_SYSTEM.md docs/SETUP.md docs/SECURITY.md docs/API.md docs/MULTI_AGENT_ARCHITECTURE.md
git commit -m "feat: deliver Phase 1 Flow development vertical slice"
```

## Execution Notes

- Execute in an isolated Git worktree created from the actual cloned repository, not the uploaded ZIP.
- Run database-backed tests with an isolated test database and transactional cleanup.
- Use mocks for model and Salesforce boundaries in unit/integration tests; use the configured development sandbox only for Apex tests and final dry-run/live acceptance.
- Do not enable live sandbox deployment until Tasks 1–13 pass and the dry-run in Task 14 succeeds.
- After Phase 1 is accepted, create separate plans for complete Flow-type coverage, general metadata, Apex, generated LWC, integrations/data, runtime hardening, and Jira.
