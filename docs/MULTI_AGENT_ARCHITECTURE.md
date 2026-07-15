# Multi-Agent Architecture

## Overview

The user still interacts with one Salesforce In-Org AI Agent. Internally, the Orchestrator Agent decomposes the verified Jira requirement into bounded specialist work items, combines their proposals into one plan, and coordinates implementation, testing, validation, deployment, and explanation.

```text
User or Jira
  -> Orchestrator Agent
  -> task decomposition and specialist selection
  -> dependency-aware specialist proposals
  -> one unified plan and implementation approval
  -> specialist-owned local implementation
  -> Testing Agent
  -> Validation and Deployment Agent
  -> separate deployment approval
  -> deployment to the exact verified org
  -> Documentation and Explanation Agent
  -> one LWC and Jira summary
```

Specialists do not receive independent approval authority and do not execute arbitrary commands. The existing allowlisted Salesforce and Git services remain the only mutation boundary.

## Specialist Registry

Agent definitions are immutable code records in `middleware/src/domain/specialistAgents.js`. Each definition contains a stable ID, user-facing name, role, owned metadata types, owned Salesforce DX path roots, and an inspection checklist.

The registry includes:

- Object and Field Agent
- Flow Agent
- Apex Agent
- LWC Agent
- UI Metadata Agent
- Security and Permissions Agent
- Integration Agent
- Data Agent
- Testing Agent
- Validation and Deployment Agent
- Documentation and Explanation Agent

The orchestrator selects only agents relevant to the requirement. Testing, validation/deployment, and explanation are common review stages. A field task also selects UI and security specialists because a new field is not usable until placement and least-privilege access are considered.

## Work Items

Every selected agent receives one persisted work item for the plan iteration. A work item contains:

- Work item and parent job IDs
- Jira issue key and iteration
- Assigned specialist agent
- Exact target org registry ID and Salesforce Organization ID
- Specialist metadata scope
- Dependency work item IDs
- Status
- Sanitized inputs and structured outputs
- Files affected
- Validation requirements and risk
- Unified approval ID after approval

The required specialist result fields are stored under `outputs`: analysis summary, existing metadata, proposed changes, create/modify lists, components not changed, dependencies, risks, assumptions, validation requirements, files affected, and completion status.

## Dependencies and Scheduling

`middleware/src/services/orchestrator.js` creates a directed acyclic dependency graph and a deterministic topological execution order. For example, Object and Field work precedes a Flow that references the field; Apex precedes an LWC that calls it; implementation work precedes independent testing; testing precedes validation and deployment.

The current queue schedules one parent job at a time. Inside that worker stage, specialist work executes in dependency order. Independent work items are represented as parallel-safe in the graph, but filesystem writes remain serialized until separate per-work-item workers and leases are introduced. This avoids concurrent writes to the same Git worktree.

## File Ownership

Every proposed file must map to exactly one specialist boundary. The plan is rejected when a file is unowned, duplicated, or assigned outside its specialist boundary.

Before a local write, the worker:

1. Resolves the approved owning work item.
2. Captures the baseline content hash.
3. Acquires the persisted file lock.
4. Uses the existing allowlisted metadata writer.
5. Captures the resulting content hash.
6. Releases the lock.

The ownership record stores path, owning agent, work item ID, lock status, baseline hash, current hash, and timestamp.

## Approvals

Specialists never request approval directly. The Orchestrator Agent consolidates their results into `plan.specialistSections`, and the existing implementation approval approves the exact unified plan hash, metadata scope hash, org, and all included work items.

Deployment remains a different approval tied to the successful validation ID, validated source hash, commit hash, package hash, and exact target org. The Validation and Deployment Agent cannot edit implementation files.

## Revisions

An instruction creates a new iteration. Revision impact analysis identifies affected specialists separately from initial requirement analysis, so mentioning an existing field does not reopen the Object and Field Agent unless the instruction asks to change that field.

Completed, unaffected work items are carried forward. Affected work items and the Testing, Validation/Deployment, and Explanation stages are recreated. Selective metadata retrieval is filtered to affected specialist boundaries. Existing parent-job artifacts remain archived in `revisions`.

Instructions received during implementation, validation, or deployment are queued and activated at the next safe parent state. Instructions after deployment reopen the completed job as a new supervised iteration.

## Structured Communication and Audit

Specialist communication uses fixed message types and fields: sender, recipient, parent job, work item, type, metadata, request, dependency, risk, and timestamp. Free-form internal commands are not accepted.

Dependency discovery, specialist proposals, status changes, implementation start/completion/failure, validation failure, file ownership, and final results are stored as concise audit events. The audit contains decisions and evidence, not hidden reasoning or model chain-of-thought.

