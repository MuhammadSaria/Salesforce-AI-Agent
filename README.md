# Salesforce In-Org AI Agent

A supervised, Jira-driven Salesforce development agent. It preserves the existing LWC/Apex/Express/BullMQ/Redis architecture and enforces one verified org, selective metadata retrieval, versioned plans, implementation approval, local-only implementation, validation, a separate execution approval, exact-org metadata deployment or allowlisted record execution, Jira reporting, and an audit trail.

## Architecture

```text
Salesforce LWC -> Apex -> authenticated Named Credential -> Express API
                                                        -> BullMQ -> Worker
Jira webhook -> signature + idempotency --------------------^
Worker -> Orchestrator -> specialist work-item graph -> unified plan approval
       -> specialist-owned local implementation -> independent testing
       -> exact-org validation -> separate deployment approval -> deployment
Redis -> jobs, state history, approvals, validations, deployment records
JSONL -> append-only operational audit copy
Successful deployment -> Documentation Agent -> versioned PDF, Word, and Markdown reports
```

The LWC never receives credentials. Jira content, Salesforce data, and user instructions are untrusted requirement inputs and cannot authorize commands, select arbitrary aliases, or bypass approvals. Internally selected specialists have strict metadata and file boundaries; they return structured results to the Orchestrator Agent and cannot deploy independently. Jira collaboration is handled by **Providus Nexus**, which responds conversationally while keeping technical and approval details in Salesforce.

## Repository

```text
force-app/main/default/classes/              Apex proxy and tests
force-app/main/default/lwc/agentChat/         supervised job console
Salesforce Setup                              admin-managed Named/External Credential
force-app/main/default/customPermissions/     deployment approver permission
middleware/config/org-registry.json           inactive example registry entry
middleware/src/domain/                        parent/work-item states and specialist registry
middleware/src/middleware/                    API authentication/authorization
middleware/src/services/                      Jira, org, planning, CLI, Git, audit
middleware/src/queue/                         BullMQ/Redis queue
middleware/test/                              Node security and lifecycle tests
jobs/<jobId>/                                 isolated runtime artifacts (generated)
workspaces/<orgRegistryId>/                   isolated org workspaces (generated)
docs/                                         API, setup, persistence, security
```

## Safe Workflow

`RECEIVED -> AWAITING_ORG_SELECTION|VERIFYING_ORG -> ANALYZING_JIRA -> DISCOVERING_METADATA -> RETRIEVING_RELEVANT_METADATA -> ANALYZING_DEPENDENCIES -> AWAITING_REQUIREMENTS|AWAITING_PLAN_APPROVAL -> IMPLEMENTING -> VALIDATING -> AWAITING_DEPLOYMENT_APPROVAL -> DEPLOYING -> COMPLETED`

Implementation and execution approvals are different durable records. Each is bound to the plan hash, metadata-scope hash, registry org, and Salesforce Organization ID. The second approval is additionally bound to the validation ID, source hash, and package hash. Any org reselection invalidates all downstream artifacts. Development requests with no concrete source or record operations stop in `AWAITING_REQUIREMENTS` and cannot be approved. An org may independently allow metadata deployment and structured record operations; the checked-in Providus developer and SAPA sandbox policies currently enable bounded business-record operations while retaining a security-object denylist.

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

See [setup](docs/SETUP.md), [Providus Nexus Jira collaboration](docs/JIRA_COLLABORATION.md), [multi-agent architecture](docs/MULTI_AGENT_ARCHITECTURE.md), [implementation reports](docs/IMPLEMENTATION_REPORTS.md), [API contract](docs/API.md), [data model](docs/DATA_MODEL.md), and [security model](docs/SECURITY.md).
