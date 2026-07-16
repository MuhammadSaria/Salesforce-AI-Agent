# Persistence Model

The existing database is Redis. The upgrade retains it and stores each job as an aggregate under `agent-job:<jobId>`, indexed by `agent-jobs:index`. BullMQ stores asynchronous execution records separately. This avoids a second source of truth while the project remains small.

The aggregate contains logical models for Jira issue, job, state history, metadata scope/components, versioned plan, specialist work items, structured specialist messages, file ownership, user instructions, approvals, validation run, command executions, Git changes, deployment run, and audit events. Child records carry `jobId`; approvals also carry the exact plan/scope/org hashes; validations and deployments carry source/package hashes. These references are checked transactionally by the service, but Redis does not provide SQL foreign-key constraints.

Specialist fields are stored directly in the job aggregate:

- `iteration`: current multi-agent implementation iteration.
- `orchestration`: selected agents, dependency execution order, material-change hash, and orchestration hash.
- `workItems`: specialist scope, dependencies, status, structured inputs/outputs, files, validation requirements, and risk.
- `specialistMessages`: bounded structured communication records.
- `fileOwnership`: one owner and lock/hash record per approved file.
- `revisionContext`: affected agents and completed unaffected work carried into the next iteration.
- `deploymentHistory`: append-only successful deployment summaries and their report status.
- `implementationReports`: immutable report descriptors for each deployment version. File bytes remain in isolated artifact storage and are never stored in Redis or API job responses.

Work-item and file-ownership mutations use the existing local/Redis job lock. The single worker executes the dependency graph serially in the current version, preventing stale concurrent filesystem edits.

Webhook idempotency keys use `jira-webhook:<eventId>` with a seven-day TTL. Audit events are stored in the job aggregate and duplicated to `jobs/<jobId>/logs/audit.jsonl` as an append-only operational copy.

There is no database migration command for this version because existing Redis job keys are not rewritten; legacy jobs receive empty report/history collections when read by the UI. Production deployments needing SQL-enforced foreign keys, retention policies, immutable/WORM audit storage, backed-up report artifacts, or multi-process approval transactions should replace `jobStore.js` and the local report storage provider behind their existing interfaces before enabling production deployment.
