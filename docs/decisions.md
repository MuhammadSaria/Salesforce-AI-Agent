# Providus Nexus Decisions

This is an append-only record. Add a new dated entry when a decision changes; do not silently rewrite history.

## 2026-07-31 — Salesforce Development First

**Decision:** Complete the Salesforce development capability before adding Jira-driven operation.  
**Consequence:** Jira work remains outside the current Phase 1 implementation scope.

## 2026-07-31 — In-Org Conversational LWC

**Decision:** The user interacts with the agent through a conversational Lightning Web Component inside Salesforce.  
**Consequence:** The interface must support multi-turn conversation and job/status feedback without exposing middleware credentials.

## 2026-07-31 — Privileged Integration User with Guardrails

**Decision:** Salesforce execution may use a dedicated System Administrator integration user so profile and field-permission gaps do not block approved development work.  
**Consequence:** Elevated Salesforce permissions do not bypass exact-org verification, allowlisted commands, audit logging, plan approval, validation, or deployment approval.

## 2026-07-31 — Separate Approval Boundaries

**Decision:** Implementation approval and deployment approval are separate durable approvals bound to the exact plan, source, validation, and org identities.  
**Consequence:** Implemented local changes cannot deploy solely because implementation was approved.

## 2026-07-31 — Recurring Donation Installments

**Decision:** For a recurring donation, each paid/complete donation record receives its sequential installment number when that donation is created: first donation is installment 1, second donation is installment 2, and so on.  
**Consequence:** Installment numbering must be deterministic, sequential, and protected against duplicate processing.

## 2026-08-01 — GitHub Is Durable Work State

**Decision:** Every completed task must be verified, committed, and pushed; temporary worktrees are not accepted as the only copy of completed work.  
**Consequence:** A session must not claim completion without a pushed commit SHA.

## 2026-08-01 — One Coherent Task per Codex Chat

**Decision:** Each implementation chat handles one numbered Phase 1 task unless two inseparable steps share one verification boundary.  
**Consequence:** New chats resume from `AGENTS.md`, `docs/progress.md`, the Git branch, and the selected task rather than old transcripts.

## 2026-08-13 — Task 8 Generators Must Be Reachable Through the Bounded Runner

**Decision:** Task 8 replaces the direct Salesforce-chat placeholder runners with the Object/Field, Security, and inactive Flow generators through the existing bounded specialist runner. The Flow specialist receives strict dependency results from both Object/Field and Security; production generator selection is explicit, while tests may inject deterministic runners.

**Consequence:** Task 8 includes the narrow runner dependency, `agent.js` wiring, and regression coverage needed to prove the generators are reachable with the required upstream context. It does not grant generators authority to select an org, approve work, write source, validate, deploy, or bypass the strict Task 7 request/result contracts.
