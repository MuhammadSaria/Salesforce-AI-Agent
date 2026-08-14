# Providus Nexus Phase 1 API

All `/api/*` endpoints require `Authorization: Bearer <MIDDLEWARE_API_TOKEN>`. Direct Salesforce routes also require `X-Agent-Source: Salesforce-Apex`, `X-Agent-Org-Id`, `X-Agent-User-Id`, `X-Agent-Can-Implement`, and `X-Agent-Can-Deploy`; permission values must be literal `true` or `false`.

Errors are `{ "error": { "code": "...", "message": "..." } }`. Important codes: `200` read/success, `201` created, `202` queued, `401` invalid trust, `403` permission denied, `404` unavailable/not-owned, `409` stale state/authority, `422` invalid input, and `503` failed readiness.

## Conversations

- `POST /api/jobs`: `{ "prompt": "Number each completed Donation for its Recurring Donation." }` → `{ "jobId", "status", "message" }`.
- `GET /api/jobs`: returns `{ "jobs": [...] }`, filtered to authorized conversations.
- `GET /api/jobs/:jobId`: safe public lifecycle, conversation, clarification, inspection/plan, work items, approvals, Task 9 evidence, baseline/implementation, Salesforce validation, deployment, and report. The original prompt is removed.
- `POST /api/jobs/:jobId/messages`: `{ "text": "qualifyingStatus=Completed; reversalPolicy=retain; numberingRule=highest-plus-one" }` persists the message and queues understanding.
- `POST /api/jobs/:jobId/cancel`: optional `{ "reason": "..." }`.

Detail reads are `GET /api/jobs/:jobId/plan`, `/validation`, `/diff`, `/logs`, `/audit`, `/work-items`, and `/specialist-messages`. `GET /api/orgs` and `/api/orgs/:orgId` expose bounded registry data. `/health` is liveness and `/ready` checks dependencies.

## Approvals and actions

- `POST /api/jobs/:jobId/approve-implementation` requires implementation permission and `{ "planVersion": 1, "planHash": "...", "scopeHash": "..." }`. Approval and outbox dispatch are atomic.
- `POST /api/jobs/:jobId/reject-plan` accepts optional bounded comments.
- `POST /api/jobs/:jobId/implement` and `/validate` queue already-approved stages; the direct approval path dispatches implementation normally.
- `POST /api/jobs/:jobId/approve-deployment` requires deployment permission and `{ "validationId": "0Af...", "comments": "optional" }`. All hashes come from server state.
- `POST /api/jobs/:jobId/reject-deployment` rejects the current validation.
- `POST /api/jobs/:jobId/deploy` accepts no artifact/org selector; it requires exact current approval, transitions to `DEPLOYING`, and queues guarded deployment.
- `POST /api/jobs/:jobId/approve-data-preview` requires implementation permission and `{ "previewHash": "...", "comments": "optional" }` when more than ten records are affected.

Jira webhook/analyze/instructions routes exist only with `JIRA_ENABLED=true` and are outside the default direct-chat workflow.

## Lifecycle and result

`RECEIVED → UNDERSTANDING → AWAITING_CLARIFICATION → UNDERSTANDING → INSPECTING_ORG → PLANNING → AWAITING_IMPLEMENTATION_APPROVAL → IMPLEMENTING → VALIDATING → AWAITING_DEPLOYMENT_APPROVAL → DEPLOYING → COMPLETED`.

`WAITING_FOR_LOCK`, `CORRECTING`, `FAILED`, and `CANCELLED` are controlled alternatives. Material findings may return to clarification; mechanical correction is limited to three cycles. A completed recurring-donation job has `validation.status: "SUCCEEDED"`, `baselineCommit`, `deployment.activated: false`, no `jira` field, and a real `reportId` with inactive-deployment wording.
