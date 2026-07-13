# Persistence Model

The existing database is Redis. The upgrade retains it and stores each job as an aggregate under `agent-job:<jobId>`, indexed by `agent-jobs:index`. BullMQ stores asynchronous execution records separately. This avoids a second source of truth while the project remains small.

The aggregate contains logical models for Jira issue, job, state history, metadata scope/components, versioned plan, user instructions, approvals, validation run, command executions, Git changes, deployment run, and audit events. Child records carry `jobId`; approvals also carry the exact plan/scope/org hashes; validations and deployments carry source/package hashes. These references are checked transactionally by the service, but Redis does not provide SQL foreign-key constraints.

Webhook idempotency keys use `jira-webhook:<eventId>` with a seven-day TTL. Audit events are stored in the job aggregate and duplicated to `jobs/<jobId>/logs/audit.jsonl` as an append-only operational copy.

There is no database migration command for this version because existing Redis job keys are not rewritten. Production deployments needing SQL-enforced foreign keys, retention policies, immutable/WORM audit storage, or multi-process approval transactions should replace `jobStore.js` behind its existing interface before enabling production deployment.
