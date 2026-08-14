# Providus Nexus Salesforce Development Core Design

**Date:** 2026-07-31  
**Status:** Approved  
**Selected approach:** Rebuild the core workflow inside the existing project

## 1. Objective

Providus Nexus is a conversational Salesforce development system embedded in Salesforce as a Lightning Web Component. A user describes a Salesforce requirement in natural language. Providus Nexus clarifies material ambiguity, inspects the same development sandbox, creates a source-free implementation plan, and waits for authorized approval. Hidden specialist workers then generate bounded Salesforce source, validate it, correct mechanical failures, request separate deployment approval, and deploy the exact validated package to the same sandbox.

The long-term product supports complete Salesforce development: metadata configuration, Flow, Apex, Lightning Web Components, integrations, security, testing, data operations, validation, deployment, reporting, and rollback. Delivery is incremental, with a Flow use case serving as the first end-to-end acceptance test.

Jira, production deployment, multi-org targeting, and automatic Flow activation are excluded from Phase 1.

## 2. Design Decisions

- Users interact with one chatbot named Providus Nexus.
- Specialist workers remain hidden behind an Orchestrator.
- The LWC runs in the same development sandbox that receives changes.
- A dedicated integration user has the System Administrator profile in that sandbox.
- Every Salesforce action explicitly targets and verifies that sandbox; default-org fallback is forbidden.
- Every Salesforce user may chat and request a plan.
- Implementation and deployment require separate custom permissions and approvals.
- Planning and source generation are separate stages.
- Flows deploy inactive and are never activated by the agent.
- Destructive changes use the ordinary implementation approval but must be clearly disclosed in the plan.
- Git history and an immutable metadata baseline provide rollback protection.
- Up to 10 approved record changes may run automatically; larger changes require preview and confirmation.
- Parallel jobs are allowed only when their component scopes do not conflict.
- Persistent task conversations survive logout and service restart.

## 3. Existing-System Assessment

The existing repository already provides an LWC, Apex controller, Express middleware, Redis/BullMQ queueing, Salesforce CLI and Git wrappers, approval models, specialist definitions, validation, deployment, Jira integration, reports, and historical job artifacts.

The core reliability problem is that planning and complete source generation are coupled in one large, schema-constrained model response. A truncated or invalid response fails the job. Existing specialist records primarily categorize ownership of a unified response rather than performing independent bounded work. Some historical jobs reached planning with an empty metadata scope, failed with a truncated model error, or reported that no deployment was required despite a requested change. Existing generated Flow evidence also used an Active status, which conflicts with the approved inactive-deployment rule.

The design therefore preserves useful infrastructure while replacing the central planning and execution workflow. Jira code may remain temporarily but must be disabled and isolated from Phase 1 job states, prompts, APIs, and UI behavior.

## 4. Core Architecture

The synchronous request path is:

1. Salesforce user interacts with the Providus Nexus LWC.
2. LWC calls an Apex controller.
3. Apex calls the authenticated middleware through a Named/External Credential.
4. Middleware authenticates the caller, persists the message, and returns quickly.
5. Slow work is scheduled through BullMQ and executed by workers.

The execution path is:

1. Conversation and requirement engine
2. Exact-sandbox verification
3. Deterministic org inspection
4. Source-free planning
5. Implementation approval
6. Orchestrator dependency graph
7. Bounded specialist generation
8. Structural and local checks
9. Salesforce validation and controlled correction
10. Deployment approval
11. Exact validated-package deployment
12. Implementation report and rollback reference

The model cannot approve work, select another org, run arbitrary commands, or deploy directly.

## 5. Persistent Development Job

Every new request becomes a Development Job containing:

- Initiating Salesforce user
- Verified sandbox identity
- Persistent conversation
- Requirement and acceptance criteria
- Clarification questions and answers
- Org-inspection evidence
- Versioned plans
- Specialist work items and dependencies
- Approvals and approvers
- Baseline hashes, generated files, diffs, and commits
- Validation attempts and correction history
- Data-operation previews and results
- Deployment evidence
- Reports, rollback information, and append-only audit events

The principal states are:

`UNDERSTANDING` → `AWAITING_CLARIFICATION` → `PLANNING` → `AWAITING_IMPLEMENTATION_APPROVAL` → `IMPLEMENTING` → `VALIDATING` → `AWAITING_DEPLOYMENT_APPROVAL` → `DEPLOYING` → `COMPLETED`.

Recoverable alternatives include `CORRECTING`, `WAITING_FOR_LOCK`, `CANCELLED`, and `FAILED`. A failed state must contain a safe, specific explanation and next action.

## 6. Conversation and Requirements

Providus Nexus distinguishes new requirements, clarification answers, plan revisions, general questions, approvals, cancellations, and status inquiries.

It asks only material questions: questions whose answers change business behavior, data, security, dependencies, or approved scope. Safe technical decisions are made using Salesforce best practices and explained in the plan.

The planning stage contains no generated source. A plan includes:

- Confirmed business requirement
- Acceptance criteria
- Assumptions and unresolved non-blocking risks
- Current-org findings and cited evidence
- Components to create, modify, or delete
- Specialist assignments and dependencies
- Expected business behavior
- Security and data effects
- Testing strategy
- Deployment scope
- Rollback strategy

Each material revision creates a new numbered plan. Approval is bound to the plan hash, component-scope hash, org ID, approver, timestamp, and comments. A material change invalidates the approval.

## 7. Specialist Execution

The Orchestrator selects only required specialists:

- Org Analysis
- Object and Field
- Flow
- Apex
- LWC
- Security and Permissions
- Integration
- Data
- Testing
- Validation and Deployment
- Documentation

Each selected specialist receives only the confirmed requirement, exact sandbox identity, relevant retrieved metadata, approved component scope, dependency outputs, baseline hashes, and permitted metadata/file boundaries.

Each implementation specialist returns complete create/modify/delete file operations, dependencies, risks, tests, and a completion or blocked result. It does not return patches, commands, placeholders, secrets, partial XML, or out-of-scope files.

Deterministic validators check every specialist result before any write. The Validation and Deployment specialist cannot modify implementation source. Specialists cannot approve their own work.

## 8. Dependencies, Isolation, and Concurrency

The Orchestrator builds a dependency graph. Dependent work runs in order; independent work may run concurrently.

Examples:

- Object and Field precedes a Flow that references a new field.
- Apex precedes an LWC that imports its controller.
- Implementation precedes independent Testing.
- Testing precedes combined Salesforce validation.

Every job declares a metadata component scope. The system acquires component locks before implementation. Conflicting jobs wait; unrelated jobs may proceed. Each job receives an isolated Git worktree and branch. Locks use leases and are released after completion, cancellation, failure, or worker recovery.

Before modification, the worker retrieves affected metadata, records immutable baseline hashes, and creates a baseline commit. Rollback restores the selected baseline through a separately approved deployment.

## 9. Validation and Controlled Correction

Validation uses four gates:

1. **Source integrity:** owned paths, complete documents, approved source hashes, no secrets, no arbitrary commands, and no unapproved dirty files.
2. **Metadata semantics:** type-specific structure, API names, references, connectors, element ordering, executable paths, and inactive Flow status.
3. **Local checks:** parsers, lint, Jest, manifest checks, required Apex tests, and Flow structural/semantic validation.
4. **Salesforce validation:** minimal package validation against the exact verified sandbox using the appropriate Apex test level.

Failures are classified as:

- **Mechanical:** malformed XML, incorrect ordering, missing manifest entry, compilation or formatting problem. The owning specialist may repair within the approved scope.
- **Material:** changed business logic, expanded component scope, new data behavior, new security effect, or unrelated component change. Return to planning and require new approval.
- **Infrastructure:** queue, worker, database, Redis, model provider, CLI, network, or Salesforce availability failure. Retry with bounded backoff without source mutation.

Mechanical correction is limited to three validation cycles by default. Exhaustion creates a recoverable failed state with validation evidence and attempted repairs.

## 10. Deployment and Data Operations

Deployment requires a separate authorized approval tied to the validation ID, source hash, package hash, commit hash, exact sandbox, and expiration time. Changed source or an expired validation invalidates approval.

Flows deploy inactive. Providus Nexus never activates a Flow. Deployment failure does not authorize source mutation; the failure is classified before the next action.

The sandbox integration user may read and modify any sandbox record when required by an approved job. Every DML operation records the object, operation, filter or IDs, estimated/actual count, before/after evidence where practical, and recovery outcome. Up to 10 records may change automatically within the approved scope. More than 10 require a separate preview and confirmation. Metadata deployment and data execution remain distinct audited actions.

## 11. Persistence and Runtime Infrastructure

Storage responsibilities are:

- **PostgreSQL:** jobs, conversations, requirements, plans, approvals, states, locks, validation history, and audit events.
- **Redis/BullMQ:** queues, retry scheduling, worker leases, short-lived progress, and heartbeats.
- **Git/worktrees:** metadata baselines, generated source, diffs, commits, and rollback versions.
- **Artifact storage:** validation files, implementation reports, and large logs.
- **Salesforce:** LWC interface, caller identity, and custom-permission enforcement.

The API handles short interactive actions. Workers handle metadata retrieval, model execution, generation, tests, validation, data operations, and deployment. Local development may use Docker Compose; shared use requires persistent managed services, TLS, monitoring, backup, process supervision, and secret management.

## 12. Identity, Authorization, and Security

A dedicated System Administrator integration user is authenticated only to the same Phase 1 development sandbox. Every Salesforce operation explicitly supplies the configured target and verifies organization ID, instance URL, username, and environment. Other sandboxes and production are inaccessible.

Every user may chat and request a plan. Implementation requires `AI_Agent_Admin` or an equivalent custom permission. Deployment and rollback require `AI_Agent_Deploy`. Apex checks permissions before transmitting an approval; middleware independently verifies signed caller identity and claims.

Security boundaries include:

- No secrets in model prompts, logs, reports, or Salesforce records
- No arbitrary shell execution
- Allowlisted Salesforce CLI and Git operations only
- No default Salesforce org
- No production target in Phase 1
- No model-generated approval, org selection, or deployment authority
- Prompt, record, and metadata content treated as untrusted input
- Destructive changes disclosed in the approved plan
- Append-only approval and audit evidence

## 13. Salesforce LWC Experience

The LWC is a chat workspace containing:

- Persistent conversation sidebar with search and New Request
- Always-visible verified sandbox name and environment
- Chat timeline for messages, questions, explanations, plans, progress, and results
- Business-readable plan cards
- Specialist progress without hidden reasoning
- Permission-gated implementation, deployment, and rollback controls
- Validation and deployment result cards
- Report and rollback links
- Message composer for answers, revisions, questions, cancellation, and status

Internal states are translated into plain language. Providus Nexus never claims implementation, validation, or deployment without corresponding execution evidence.

## 14. First Acceptance Test: Recurring-Donation Installments

The test request is: when a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.

The agent inspects the sandbox to identify actual objects, relationships, status field/value, existing installment field, automation, layouts, and permission sets. It asks when multiple plausible business interpretations remain.

Confirmed rules:

- Only Paid/Completed Donations receive a number.
- Assignment occurs when created completed or later changed to completed.
- Numbering is independent for each Recurring Donation.
- The next number is the highest existing related Installment Number plus one.
- The first qualifying Donation receives 1.
- Existing numbered Donations are not overwritten.
- Cancelled or reversed Donations retain their historical number.
- Deleted records do not cause renumbering.
- A missing Number field, security, and layout placement are included in the plan.
- The Flow deploys inactive.

Required scenarios include first, second, pending, pending-to-completed, reversed, deleted-gap, existing-number, missing-parent, bulk, and missing-dependency cases.

A Flow-only highest-number calculation can duplicate a number when two Donations for the same Recurring Donation complete concurrently. The plan must disclose this limitation. Strict uniqueness requires a material change to a locking-capable Apex design and new approval.

The milestone passes only when the LWC conversation, verified org inspection, actionable plan, approvals, real specialist-generated source, validation, controlled correction, inactive deployment, report, and rollback baseline all have truthful execution evidence. Jira must not participate.

## 15. Delivery Roadmap

1. Conversational core and persistent jobs
2. Reliable same-sandbox org inspection
3. Flow vertical slice using the installment acceptance test
4. Coverage for record-triggered, scheduled, screen, autolaunched, platform-event, and subflows
5. Objects, fields, record types, layouts, FlexiPages, permission sets, and validation rules
6. Apex classes, triggers, async Apex, test generation, and test execution
7. LWC bundles, Apex/UI API integration, and Jest
8. Integrations, mocks, and controlled SOQL/DML
9. Parallel-job reliability, locks, recovery, monitoring, and managed storage
10. Jira as an optional input adapter

Every milestone extends the same lifecycle and must have its own acceptance tests before the next capability is enabled.

## 16. Phase 1 Exclusions

- Jira polling, webhooks, comments, or attachments
- Production deployment
- Multi-org target selection
- Automatic Flow activation
- Arbitrary model-generated commands
- Changes outside approved metadata/data scope
- Guaranteed concurrency-safe installment numbering without an approved Apex design

## 17. Phase 1 Definition of Success

A normal Salesforce user can describe the recurring-donation requirement in the LWC. Providus Nexus persists the conversation, asks only material questions, inspects the same sandbox, and prepares a truthful actionable plan. An authorized user approves implementation. Bounded specialists generate real metadata, deterministic checks and Salesforce validation pass, and mechanical failures are corrected within limits. A separately authorized user approves deployment. The exact validated package deploys inactive to the same sandbox, and the job retains a report, audit evidence, Git baseline, and rollback path.
