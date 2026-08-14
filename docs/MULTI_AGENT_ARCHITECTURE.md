# Providus Nexus Phase 1 Architecture

## Implemented runtime

```text
Salesforce agentChat LWC
  ↓ fixed Apex methods and trusted permission/org/user headers
AgentController + Agent_Middleware Named Credential
  ↓ HTTPS bearer-authenticated requests
Express API + durable outbox dispatcher
  ↓ shared PostgreSQL state / Redis delivery
BullMQ worker + injected Phase 1 runtime
  ↓
same-org verifier → bounded Salesforce inspector → architecture planner
  ↓ implementation approval
Object/Field specialist → Security specialist → Flow specialist
  ↓ complete-set Task 9 source validation
PostgreSQL component leases → isolated Git worktree → immutable baseline
  ↓ exact source write/commit
Salesforce dry-run validation ↔ bounded owner-only correction (maximum 3)
  ↓ separate exact-artifact deployment approval
guarded Salesforce inactive deployment
  ↓
COMPLETED + persisted reportId (Flow remains Draft)
```

The LWC is a persistent conversation workspace. Apex exposes only fixed routes, bounds text/path values, derives custom-permission claims, and translates failures safely. The API owns authorization, lifecycle, approvals, durable conversations/jobs, and outbox delivery. Separate API and worker processes share PostgreSQL; Redis never replaces durable authority.

The worker runtime uses production dependency injection for the PostgreSQL JobStore, same-org verifier, inspector, planner, specialist runner, Task 9 validators, component-lock/baseline service, correction router, Salesforce executor, guarded deployer, and report writer. Tests replace only true model, Salesforce network, and temporary infrastructure boundaries. Production has no fake service, in-memory JobStore, inline queue, no-source completion, or preconstructed final job.

## Responsibilities

- Inspector obtains current bounded evidence from the verified source org.
- Planner proposes only an evidence-bound actionable architecture. The accepted vertical slice is exactly CustomField, PermissionSet, Flow.
- Object/Field creates the Number field; Security creates least-privilege field access; Flow creates connected executable Draft automation. Ownership cannot cross boundaries.
- Task 9 validates the complete set and business graph before source write.
- Task 10 atomically leases all components and captures an immutable exact-org baseline in an isolated Git worktree.
- Task 11 routes trusted mechanical findings only to the owner, revalidates the complete set, and stops after three cycles. Material findings need clarification; infrastructure findings consume no attempt.
- Task 12 binds validation, approval, and deployment to the same org, baseline, source, package, commit, plan, scope, inspection, lease, and validation identities. Flow must be Draft before validation and deployment.
- Reporting persists approved components and exact inactive deployment evidence without claiming activation.

## Proved recurring-donation behavior

The record-triggered Flow qualifies Donation creation as Completed and transition to Completed, requires a Recurring Donation parent and empty installment number, queries only that parent's numbered Donations ordered descending with a one-record limit, assigns 1 when none exists and N+1 otherwise, never overwrites or historically renumbers, retains numbers after reversal, and remains Draft after deployment. Highest-plus-one is best effort under concurrency, not a strict uniqueness guarantee.

## Boundaries

Phase 1 does not activate Flows, merge to main, select default orgs, deploy to production by default, perform unsupervised changes, treat Jira as authority, add Apex/Trigger/LWC to the recurring-donation solution, guarantee strict concurrent numbering uniqueness, or implement Phase 2 autonomy. Jira code is optional legacy integration and disabled by default.
