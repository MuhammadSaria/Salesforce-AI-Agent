# Reliable Universal Salesforce Agent Design

## Objective

Upgrade Providus Nexus so every Salesforce development job reaches one truthful terminal outcome: deployed successfully, completed as an explicitly informational request, cancelled by a user, or paused with a specific recoverable blocker. A development job must never report completion when no requested Salesforce change was implemented.

The system will support broad Salesforce DX metadata development and approved business-record operations while retaining exact-org verification, implementation approval, validation, separate deployment or data-execution approval, least privilege, and command allowlisting.

## Current Architecture Reused

- Express API, Jira webhook and poller
- Redis/BullMQ queue with the existing worker
- Disk job snapshots and append-only audit records
- Salesforce Org Registry and CLI verification wrapper
- Codex structured planning
- Orchestrator and Salesforce specialist work items
- Git-isolated implementation workspaces
- LWC and Apex approval console
- Validation, deployment, Jira updates, and implementation reports

## Authoritative History

`docs/CURRENT_SYSTEM.md` will become the compact, authoritative description of the current architecture, supported capabilities, operational dependencies, safety boundaries, deployment topology, and known external prerequisites. Historical Git commits, audit events, job snapshots, deployment reports, and prior design documents remain immutable evidence; compaction must not delete them.

List APIs will return lightweight job summaries with pagination. Full plans, conversations, logs, audit events, and artifacts remain available only through job-specific endpoints.

## Requirement Readiness

Add `AWAITING_REQUIREMENTS` to the job state machine. Analysis enters this state when a development request lacks information required to create an actionable source or record proposal.

The requirement gate distinguishes:

- Development requests, which require at least one approved file or data operation.
- Informational requests, which may complete without Salesforce changes.
- Blocked development requests, which must list concrete missing information and cannot be approved.

Implementation approval is rejected when a development plan has zero file operations and zero data operations. Validation cannot convert such a plan into a successful no-change completion. The LWC shows the missing questions and keeps Add Instruction available.

## Jira Attachments

The Jira service will download only allowlisted attachments from the configured Jira tenant after authenticated issue retrieval. Supported initial formats are DOCX, PDF, Markdown, text, CSV, JSON, and XML. Each attachment is subject to configurable count, per-file size, and combined extracted-text limits.

Extracted content remains untrusted requirement evidence. It is sanitized, never executed, never used for org selection or approval, never logged in full, and never allowed to override system policy. Unsupported, encrypted, oversized, or failed attachments are represented as explicit missing-information items.

## Actionable Plan Invariants

Every plan records `requestKind` as `DEVELOPMENT` or `INFORMATIONAL` and `actionability` containing:

- `actionable`
- `missingInformation`
- `attachmentFailures`
- `fileOperationCount`
- `dataOperationCount`

For development work, `actionable` is true only when at least one validated file or data operation exists and no blocking attachment or requirement failure remains.

Specialist proposal completion and implementation completion remain separate statuses. A preserved work item can be reused only if its owned files or data operations were actually implemented in the preserved iteration. A proposal-only specialist is reopened during revision.

## Salesforce Metadata Capability Registry

Create a centralized registry mapping Salesforce metadata families to:

- Specialist owner
- Source roots and text extensions
- Discovery and retrieval metadata types
- Dependency hints
- Validation requirements
- Risk and destructive-change policy

Existing specialists retain their boundaries. A General Salesforce Metadata Agent owns supported Salesforce DX metadata not claimed by another specialist, including reports, dashboards, email templates, Aura bundles, Experience Cloud text metadata, assignment rules, queues, sharing metadata, translations, and other allowlisted source-format metadata.

Structured Codex output remains the only model-to-source contract. File paths must stay under `force-app/main/default`, match an allowlisted Salesforce text extension, stay within size limits, and have one owning specialist. Binary static resources and secrets are not model-generated; they require an approved repository asset.

## Validation Correction Loop

Validation failures are classified by component and routed to the owning specialist. The job records a correction request and returns to implementation only after the existing approval rules are satisfied. Non-material fixes may reuse implementation approval; material plan, scope, org, source, or package changes invalidate approvals.

Retryable infrastructure failures use bounded retries with backoff. Deterministic source, test, permission, and dependency failures are not retried blindly. Exhausted jobs enter a recoverable failed state with the exact safe explanation.

## Source Integrity

Implementation and deployment must use a dedicated branch and job workspace. The system records the baseline commit, owned file set, source hash, package hash, and commit hash. Deployment is blocked when unapproved files, changed hashes, stale validation, a dirty implementation workspace, or a mismatched org is detected.

## Runtime Reliability

Add liveness and readiness endpoints. Readiness checks database or snapshot storage, Redis/queue connectivity, worker heartbeat, Jira configuration, Codex availability, org-registry readability, and safe workspace access without exposing secrets.

Provide Docker and Compose deployment configuration for the API, worker, Redis, and persistent volumes. Production hosting, TLS ingress, managed database, secrets manager, monitoring destination, backups, and DNS require customer-owned infrastructure credentials and remain documented provisioning steps.

Queue jobs use bounded retries, exponential backoff, stalled-job recovery, dead-letter evidence, idempotent action keys, and worker heartbeats. Disk snapshots remain a recovery fallback, not the sole production database.

## Security Boundaries

- No arbitrary shell execution
- No default Salesforce org
- No credentials from Jira, attachments, Salesforce records, or prompts
- No secret values in Codex prompts, logs, reports, or API responses
- No deployment or data mutation without separate approval
- No production inference from sandbox or implementation approval
- No security/setup-record mutation through wildcard business-data access
- No binary or executable attachment processing

## Testing

Add regression coverage for:

- TA-14-style attachment-dependent Flow requests
- Missing attachments and unsupported formats
- Development plans with zero operations
- Informational no-change jobs
- Approval rejection for blocked plans
- Proposal-only specialist revisions
- Generic metadata ownership and file-extension validation
- Retry classification and worker heartbeat readiness
- Pagination and compact job summaries
- Existing org isolation, approvals, source hashes, and deployment guards

## Success Criteria

1. TA-14 cannot reach implementation approval or completed status without an actual Flow proposal.
2. Attachment content is available to planning within security and size limits.
3. Unknown but supported Salesforce metadata is assigned to one safe fallback owner.
4. Development completion requires implemented and validated change evidence.
5. Runtime outages are detected by readiness checks and jobs resume or fail explicitly.
6. The repository contains deployable runtime configuration and one current architecture document.
7. Existing middleware and LWC tests remain green.

