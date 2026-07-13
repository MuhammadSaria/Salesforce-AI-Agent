# Salesforce In-Org AI Agent

A supervised, Jira-driven Salesforce development agent. It preserves the existing LWC/Apex/Express/BullMQ/Redis architecture and enforces one verified org, selective metadata retrieval, versioned plans, implementation approval, local-only implementation, validation, a separate execution approval, exact-org metadata deployment or allowlisted record execution, Jira reporting, and an audit trail.

## Architecture

```text
Salesforce LWC -> Apex -> authenticated Named Credential -> Express API
                                                        -> BullMQ -> Worker
Jira webhook -> signature + idempotency --------------------^
Worker -> Org Registry -> sf org display verification -> task manifest
       -> isolated jobs/<jobId> workspace -> validation -> approved deployment
Redis -> jobs, state history, approvals, validations, deployment records
JSONL -> append-only operational audit copy
```

The LWC never receives credentials. Jira content, Salesforce data, and user instructions are untrusted requirement inputs and cannot authorize commands, select arbitrary aliases, or bypass approvals.

## Repository

```text
force-app/main/default/classes/              Apex proxy and tests
force-app/main/default/lwc/agentChat/         supervised job console
Salesforce Setup                              admin-managed Named/External Credential
force-app/main/default/customPermissions/     deployment approver permission
middleware/config/org-registry.json           inactive example registry entry
middleware/src/domain/                        strict job state machine
middleware/src/middleware/                    API authentication/authorization
middleware/src/services/                      Jira, org, planning, CLI, Git, audit
middleware/src/queue/                         BullMQ/Redis queue
middleware/test/                              Node security and lifecycle tests
jobs/<jobId>/                                 isolated runtime artifacts (generated)
workspaces/<orgRegistryId>/                   isolated org workspaces (generated)
docs/                                         API, setup, persistence, security
```

## Safe Workflow

`RECEIVED -> AWAITING_ORG_SELECTION|VERIFYING_ORG -> ANALYZING_JIRA -> DISCOVERING_METADATA -> RETRIEVING_RELEVANT_METADATA -> ANALYZING_DEPENDENCIES -> AWAITING_PLAN_APPROVAL -> IMPLEMENTING -> VALIDATING -> AWAITING_DEPLOYMENT_APPROVAL -> DEPLOYING -> COMPLETED`

Implementation and execution approvals are different durable records. Each is bound to the plan hash, metadata-scope hash, registry org, and Salesforce Organization ID. The second approval is additionally bound to the validation ID, source hash, and package hash. Any org reselection invalidates all downstream artifacts. An org may independently allow metadata deployment and structured record create/update operations; SAPA is currently the only registry entry enabled for the latter.

## Quick Start

```powershell
cd middleware
Copy-Item .env.example .env
npm install
docker compose up -d redis
npm run start
```

In a second terminal:

```powershell
cd middleware
npm run worker
```

Run local checks:

```powershell
cd middleware
npm run check
```

Install and run LWC Jest tests from the repository root:

```powershell
npm install
npm run test:unit
```

Authenticate each registered org without setting or relying on a default:

```powershell
sf org login web --alias read-usa-sandbox
sf org display --target-org read-usa-sandbox --json
```

Deploy Salesforce UI metadata only after reviewing the target:

```powershell
sf project deploy start --source-dir force-app --target-org <setup-org-alias>
sf apex run test --class-names AgentControllerTest --target-org <setup-org-alias> --wait 30
```

No Salesforce org, Named Credential principal, or Jira project is configured by the checked-in examples. Configure the modern Named/External Credential in Salesforce Setup, replace registry identity values, activate only verified org records, and grant `AI_Agent_Deploy` only to authorized deployers.

See [setup](docs/SETUP.md), [API contract](docs/API.md), [data model](docs/DATA_MODEL.md), and [security model](docs/SECURITY.md).
