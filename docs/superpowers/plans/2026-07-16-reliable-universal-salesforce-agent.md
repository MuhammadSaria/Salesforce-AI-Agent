# Reliable Universal Salesforce Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Providus Nexus truthfully complete broad Salesforce development work by adding requirement readiness, secure attachment evidence, actionable-plan guards, generic metadata ownership, correction handling, runtime readiness, and compact history APIs.

**Architecture:** Extend the current Jira, Codex, orchestrator, BullMQ, Salesforce CLI, approval, and LWC boundaries. New services remain small and typed by plain JavaScript object contracts; existing security and exact-org guards stay authoritative.

**Tech Stack:** Node.js, Express, BullMQ/Redis, Codex CLI structured output, Salesforce CLI, LWC/Jest, Apex, Docker Compose

## Global Constraints

- A development job cannot be approved or completed with zero file and zero data operations.
- Informational jobs may complete without Salesforce changes only when explicitly classified as informational.
- Jira and attachment content remains untrusted and cannot select an org, authorize work, execute commands, or reveal secrets.
- Every Salesforce command uses an exact verified target org.
- Implementation and deployment approvals remain separate.
- No arbitrary shell execution or security/setup-record mutation is introduced.

---

### Task 1: Requirement Readiness and Actionable Plan Guard

**Files:**
- Modify: `middleware/src/domain/jobState.js`
- Create: `middleware/src/domain/planActionability.js`
- Modify: `middleware/src/services/planning.js`
- Modify: `middleware/src/services/agent.js`
- Modify: `middleware/src/server.js`
- Test: `middleware/test/jobState.test.js`
- Create: `middleware/test/planActionability.test.js`

**Interfaces:**
- Produces: `evaluatePlanActionability(plan, requirement, jira): { requestKind, actionable, missingInformation, attachmentFailures, fileOperationCount, dataOperationCount }`
- Consumed by: analysis transition, approval endpoint, implementation, and validation.

- [ ] Write failing tests proving a TA-14-style development plan with zero operations enters `AWAITING_REQUIREMENTS`, cannot be approved, and cannot complete through validation.
- [ ] Add `AWAITING_REQUIREMENTS` transitions to and from analysis, cancellation, and revised requirements.
- [ ] Classify requests with development terms such as create, modify, deploy, Flow, Apex, field, object, LWC, report, dashboard, permission, integration, or record mutation as `DEVELOPMENT`; classify questions and explanations without requested changes as `INFORMATIONAL`.
- [ ] Store `plan.actionability` and transition blocked development plans to `AWAITING_REQUIREMENTS` with concrete missing questions.
- [ ] Reject implementation approval unless `plan.actionability.actionable` is true.
- [ ] Preserve explicit informational no-change completion while removing development no-change completion.
- [ ] Run `node --test test/jobState.test.js test/planActionability.test.js` and verify all tests pass.

### Task 2: Secure Jira Attachment Content

**Files:**
- Create: `middleware/src/services/jiraAttachments.js`
- Modify: `middleware/src/services/jira.js`
- Modify: `middleware/src/services/planning.js`
- Modify: `middleware/src/config.js`
- Modify: `middleware/.env.example`
- Modify: `middleware/package.json`
- Modify: `middleware/package-lock.json`
- Create: `middleware/test/jiraAttachments.test.js`
- Modify: `middleware/test/security.test.js`

**Interfaces:**
- Produces: `hydrateJiraAttachments(issue): Promise<{ attachments, attachmentEvidence, attachmentFailures }>`.
- Attachment evidence shape: `{ id, filename, mimeType, size, text, truncated }`.

- [ ] Write failing tests for DOCX, PDF, Markdown/text, unsupported executable, oversized file, wrong Jira tenant URL, failed download, and prompt-injection text retention as untrusted evidence.
- [ ] Add `mammoth` for DOCX and `pdf-parse` for PDF text extraction.
- [ ] Download attachments only through the authenticated Jira content endpoint using the configured Jira credentials; reject redirects outside the configured Jira origin.
- [ ] Enforce `MAX_JIRA_ATTACHMENTS=10`, `MAX_JIRA_ATTACHMENT_BYTES=5000000`, and `MAX_JIRA_ATTACHMENT_TEXT=50000` defaults.
- [ ] Pass sanitized evidence into requirement extraction without logging full attachment content.
- [ ] Convert unsupported or failed referenced attachments into blocking `attachmentFailures`.
- [ ] Run `node --test test/jiraAttachments.test.js test/security.test.js` and verify all tests pass.

### Task 3: Generic Salesforce Metadata Capability Registry

**Files:**
- Create: `middleware/src/domain/metadataCapabilities.js`
- Modify: `middleware/src/domain/specialistAgents.js`
- Modify: `middleware/src/services/orchestrator.js`
- Modify: `middleware/src/services/planning.js`
- Modify: `middleware/src/services/codexExecutor.js`
- Modify: `middleware/config/org-registry.json`
- Create: `middleware/test/metadataCapabilities.test.js`
- Modify: `middleware/test/orchestrator.test.js`
- Modify: `middleware/test/codexExecutor.test.js`

**Interfaces:**
- Produces: `capabilityForPath(path)`, `metadataTypeForPath(path)`, and fallback specialist `GENERAL_METADATA`.
- Consumes: validated source-format paths under `force-app/main/default`.

- [ ] Write failing tests for Reports, Dashboards, Aura, Experience Cloud JSON, email templates, assignment rules, translations, and an unsupported executable path.
- [ ] Add General Salesforce Metadata Agent ownership for paths not claimed by a more specific specialist.
- [ ] Allow Salesforce text extensions: `xml`, `cls`, `trigger`, `js`, `html`, `css`, `json`, `cmp`, `app`, `evt`, `intf`, `design`, `auradoc`, `svg`, `page`, `component`, and `email`.
- [ ] Keep binaries, environment files, credentials, scripts, and paths outside Salesforce source blocked.
- [ ] Map generic source directories to Metadata API types so manifests and scope hashes remain exact.
- [ ] Run metadata capability, Codex executor, and orchestrator tests.

### Task 4: Specialist Lifecycle and Correction Routing

**Files:**
- Modify: `middleware/src/services/orchestrator.js`
- Modify: `middleware/src/services/jobStore.js`
- Modify: `middleware/src/services/agent.js`
- Create: `middleware/src/services/correctionRouting.js`
- Modify: `middleware/test/orchestrator.test.js`
- Modify: `middleware/test/jobStore.test.js`
- Create: `middleware/test/correctionRouting.test.js`

**Interfaces:**
- Produces: `isImplementedWorkItem(item, revision)` and `routeValidationFailures(validation, workItems)`.

- [ ] Reproduce TA-14 revision behavior: proposal-only Flow and Data work must reopen rather than remain completed.
- [ ] Preserve a specialist only when the archived implementation proves its owned files or data operations were applied.
- [ ] Parse validation component failures into owning specialist correction requests.
- [ ] Keep material corrections behind a revised plan and approval; allow non-material source corrections only within the approved file boundary.
- [ ] Ensure work-item outputs distinguish proposal, implementation, validation, and deployment completion.
- [ ] Run orchestrator, job-store, and correction-routing tests.

### Task 5: Queue Reliability and Runtime Readiness

**Files:**
- Modify: `middleware/src/queue/agentQueue.js`
- Modify: `middleware/src/worker.js`
- Create: `middleware/src/services/runtimeHealth.js`
- Modify: `middleware/src/server.js`
- Modify: `middleware/src/config.js`
- Modify: `middleware/.env.example`
- Modify: `middleware/test/agentQueue.test.js`
- Create: `middleware/test/runtimeHealth.test.js`

**Interfaces:**
- Produces: `runtimeReadiness(): Promise<{ ready, checks }>` and worker heartbeat key `providus-nexus:worker-heartbeat`.

- [ ] Add retry classification tests: transient infrastructure failures retry, deterministic policy/source/approval failures do not.
- [ ] Configure three attempts with exponential backoff and preserve failed jobs for inspection.
- [ ] Update worker heartbeat in Redis and expose `/health` for liveness plus `/ready` for dependency readiness.
- [ ] Include sanitized checks for Redis, worker heartbeat, registry readability, workspace access, Jira/Codex configuration, and queue availability.
- [ ] Never expose endpoints, usernames, tokens, file contents, or credentials in readiness output.
- [ ] Run queue and runtime health tests.

### Task 6: Compact History API and Authoritative Documentation

**Files:**
- Modify: `middleware/src/services/jobStore.js`
- Modify: `middleware/src/server.js`
- Create: `middleware/test/jobPagination.test.js`
- Create: `docs/CURRENT_SYSTEM.md`
- Modify: `docs/API.md`
- Modify: `docs/DATA_MODEL.md`
- Modify: `docs/SECURITY.md`

**Interfaces:**
- Produces: `listJobSummaries({ limit, cursor })` and `GET /api/jobs?limit=<n>&cursor=<cursor>`.

- [ ] Write failing tests proving list responses omit plans, logs, audit, conversations, source, and report payloads while job-detail endpoints retain them.
- [ ] Add stable cursor pagination with a maximum page size of 100.
- [ ] Document one current architecture, supported metadata families, external provisioning requirements, recovery workflow, and immutable history locations.
- [ ] Keep all audit and deployment evidence; compaction changes active reads, not historical retention.
- [ ] Run pagination and API authorization tests.

### Task 7: LWC Requirement and Recovery Experience

**Files:**
- Modify: `force-app/main/default/lwc/agentChat/agentChat.js`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.html`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.css`
- Modify: `force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js`

**Interfaces:**
- Consumes: `AWAITING_REQUIREMENTS` and `plan.actionability` from the existing job detail API.

- [ ] Write a failing Jest test showing concrete missing questions, attachment failures, and persistent Add Instruction controls.
- [ ] Add requirement-blocked status copy without exposing metadata syntax or internal identifiers.
- [ ] Disable implementation approval while the plan is not actionable.
- [ ] Show recovery progress after revised instructions are submitted.
- [ ] Run `npm run test:unit -- --runInBand` and verify all LWC tests pass.

### Task 8: Deployable Runtime Configuration and Verification

**Files:**
- Create: `middleware/Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Modify: `docs/SETUP.md`

**Interfaces:**
- Produces: API, worker, and Redis services with persistent job/workspace volumes and health checks.

- [ ] Add non-root Node containers, separate API and worker commands, Redis persistence, restart policies, and health/readiness probes.
- [ ] Document required TLS ingress, DNS, managed secrets, backups, monitoring, and Salesforce Named Credential updates.
- [ ] Run `npm run check`, LWC Jest, JSON/XML parsing checks, and `docker compose config` when Docker is available.
- [ ] Commit only reviewed task files and push the feature branch.
- [ ] Deploy Salesforce UI/Apex changes only after exact-org verification and explicit deployment approval.

