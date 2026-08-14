# Providus Nexus Current System

Phase 1 is an implemented supervised Salesforce development workflow initiated directly from the persistent `agentChat` LWC. A user creates a conversation without Jira, answers material clarification, reviews an evidence-bound architecture plan, and an authorized executor approves implementation. The worker runs bounded specialists, deterministic source validation, locks/baseline capture, exact source commit, Salesforce validation, optional bounded correction, separate deployment approval, guarded inactive deployment, and report generation.

The official recurring-donation slice creates exactly:

1. `CustomField:GiftTransaction.Installment_Number__c`
2. `PermissionSet:Providus_Recurring_Donation_Installments`
3. `Flow:Assign_Recurring_Donation_Installment`

Clarification resolves `qualifyingStatus=Completed`, `reversalPolicy=retain`, and `numberingRule=highest-plus-one`. The Flow handles create-as-completed and transition-to-completed, excludes already-numbered/unparented/nonqualifying Donations, queries the same Recurring Donation in descending installment order with a one-record limit, assigns first=1 and subsequent=N+1, never overwrites or renumbers history, retains numbers after reversal, and remains Draft.

PostgreSQL persists jobs, conversation, approvals, outbox, validation, leases, baseline, corrections, deployment, and report identity across API/worker restarts. Redis transports work only. Same-org verification and evidence integrity bind every stage to the authenticated org. Task 9 validates the full generated set; Task 10 holds fenced component leases and an immutable baseline; Task 11 allows at most three owner-only mechanical corrections; Task 12 requires successful current Salesforce validation and separate exact-artifact approval. Data previews affecting more than ten records require a distinct approval.

A successful job reaches `COMPLETED` only after deployment evidence is durable. Its Flow is deployed inactive: source has `<status>Draft</status>` and deployment records `activated: false`. The real `reportId` binds baseline, validation, deployment, and artifact hashes and says “deployed inactive.” Jira is absent from direct jobs and disabled by default.

Phase 1 intentionally does not activate Flow, perform a real production rollout, use a default Salesforce org, bypass approvals/leases/validation, treat missing source as success, require Jira, guarantee collision-free concurrent highest-plus-one numbering, merge to main, or implement Phase 2.
