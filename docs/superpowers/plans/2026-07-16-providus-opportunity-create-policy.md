# Providus Opportunity Create Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit approval-gated Opportunity record creation in the verified Providus developer org without allowing updates, deletions, or access to other objects.

**Architecture:** Extend the existing centralized Salesforce Org Registry policy for `providus_orgfarm_dev`. The existing org context and Salesforce executor continue to enforce the allowlist and approval gates; no new executor path is introduced.

**Tech Stack:** Node.js, Node test runner, JSON Salesforce Org Registry

## Global Constraints

- Allow only the `Opportunity` object.
- Allow only the `data-create` mutation operation.
- Keep record updates and deletions blocked.
- Limit each approved execution to no more than ten data operations.
- Do not create Salesforce records as part of the policy change.

---

### Task 1: Add the Providus create-only data policy

**Files:**
- Modify: `middleware/test/orgRouting.test.js`
- Modify: `middleware/config/org-registry.json`

**Interfaces:**
- Consumes: `getRegisteredOrg(orgRegistryId)` and `isDataObjectAllowed(orgContext, objectApiName)` from `middleware/src/services/orgRegistry.js`
- Produces: A normalized org context allowing only approval-gated Opportunity creates.

- [x] **Step 1: Write the failing policy test**

Add a test that loads `providus_orgfarm_dev` and asserts `dataMutationPermission === 'allowed'`, `recordDeletionPermission === 'blocked'`, `maximumDataOperations === 10`, `data-create` is present, `data-update` and `data-delete` are absent, Opportunity is allowed, and Account is not allowed.

- [x] **Step 2: Run the focused test and verify the policy assertions fail**

Run: `node --test test/orgRouting.test.js`

Expected: FAIL because the registered org currently defaults to blocked data mutations and has no allowed data objects.

- [x] **Step 3: Add the minimal registry policy**

Set the Providus registry record to:

```json
"dataMutationPermission": "allowed",
"recordDeletionPermission": "blocked",
"allowedDataObjects": ["Opportunity"],
"restrictedDataObjects": [],
"maximumDataOperations": 10,
"allowedOperations": ["read", "retrieve", "validate", "deploy", "data-create"]
```

- [x] **Step 4: Run focused and full verification**

Run: `node --test test/orgRouting.test.js`

Expected: PASS.

Run: `npm run check`

Expected: lint and all middleware tests PASS.

- [ ] **Step 5: Commit the isolated policy change**

```bash
git add middleware/test/orgRouting.test.js middleware/config/org-registry.json docs/superpowers/plans/2026-07-16-providus-opportunity-create-policy.md
git commit -m "Allow approved Opportunity creation in Providus org"
```
