# Providus Nexus Current System

## Purpose

Providus Nexus is a supervised Salesforce development service. Jira supplies requirements and progress comments. The Salesforce Lightning application is the approval and review surface. The middleware coordinates org verification, specialist planning, local source changes, validation, deployment, Jira updates, and immutable implementation reports.

## Required Lifecycle

1. Receive a Jira issue or manual instruction.
2. Select exactly one trusted org-registry entry.
3. Verify the connected alias against the expected Salesforce Organization ID and instance URL.
4. Read the Jira issue and supported attachment content as untrusted requirements.
5. Retrieve only relevant metadata and analyze bounded dependencies.
6. Build specialist work items and one unified, human-readable plan.
7. Block in `AWAITING_REQUIREMENTS` when a development plan contains no concrete source or record operations.
8. Wait for explicit implementation approval.
9. Create approved changes in an isolated Git worktree without deploying.
10. Validate against the same verified org.
11. Route validation failures back to the owning specialist.
12. Wait for separate deployment approval.
13. Deploy only the validated package to the same org.
14. Update Jira and generate versioned PDF, Word, and Markdown implementation reports.

## Runtime Services

- API: Express middleware and authenticated Salesforce endpoints.
- Queue: BullMQ with Redis, three attempts, and exponential backoff.
- Worker: executes analysis, implementation, validation, and deployment jobs and publishes a short-lived Redis heartbeat.
- Jira poller/webhook: detects assigned issues and new comments with idempotency protection.
- Codex: produces constrained structured proposals; it cannot execute shell or Salesforce commands directly.
- Salesforce CLI service: executes allowlisted commands with an explicit verified target org.

`GET /health` is a liveness check. `GET /ready` requires the durable queue, a fresh worker heartbeat, Jira configuration, middleware authentication, and the configured Codex backend. Readiness responses contain booleans only and never expose secrets or connection strings.

## History and Audit

`GET /api/jobs` returns a paginated compact list for the LWC. `GET /api/jobs/:jobId` returns the selected job. Logs, audit events, specialist messages, diffs, validation results, reports, and deployment history remain available through their job-specific endpoints. Extracted attachment text is retained for planning but is not returned to Salesforce clients.

## Safety Boundaries

- Implementation approval and deployment approval are separate durable records.
- Every Salesforce operation reverifies the exact org and includes `--target-org`.
- Jira text, attachments, Salesforce data, and user instructions cannot override security or approvals.
- Salesforce source is limited to supported text metadata paths under `force-app/main/default`.
- Executables, scripts, secrets, path traversal, arbitrary shell commands, and cross-org access are blocked.
- Data changes use structured operations, org policy limits, validation, and separate execution approval.
- Production deployment remains blocked unless the org policy and production-specific approval both permit it.

## Operational Limitation

The included local Redis, worker, and ngrok scripts are suitable for development testing, not permanent availability. Reliable shared use requires deployment of the API, worker, Redis, and workspace storage on managed infrastructure with TLS, process supervision, backups, monitoring, and secret management.
