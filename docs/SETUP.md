# Providus Nexus Phase 1 Setup

Phase 1 requires Node.js 20.11+, Git, Docker Compose, Salesforce CLI (`sf`), PostgreSQL 16, and Redis 7. Commands below start at the repository root.

## Install and migrate

Compose credentials are local-development defaults only. Never reuse them outside a workstation.

```powershell
cd middleware
Copy-Item .env.example .env
docker compose up -d postgres redis
npm.cmd install
$env:DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus'
npm.cmd run migrate
```

Create the isolated test database once if absent:

```powershell
docker compose exec -T postgres createdb -U providus providus_nexus_test
$env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'
```

`npm run migrate` applies SQL files lexically and records them in `schema_migrations`. Files `001`–`005` build the complete schema, including durable outbox retries and multi-component lease sets; no manual `ALTER TABLE` is required.

## Environment

Required production settings are `DATABASE_URL`, `REDIS_URL`, `QUEUE_DRIVER=redis`, a long random `MIDDLEWARE_API_TOKEN`, `SALESFORCE_ORG_REGISTRY_PATH`, `PROJECT_ROOT`, `WORKSPACE_ROOT`, and `AGENT_BACKEND=codex`. Install/authenticate the configured `CODEX_COMMAND` on the worker host.

Runtime settings include `NODE_ENV`, `PORT`, `ALLOWED_ORIGINS`, `LOG_LEVEL`, `CODEX_COMMAND_WINDOWS`, `CODEX_TIMEOUT_MS`, `SF_COMMAND_TIMEOUT_MS`, `SF_CLI_NODE`, `SF_CLI_RUN`, `MAX_PROMPT_LENGTH`, `MAX_METADATA_COMPONENTS`/`MAX_RETRIEVED_COMPONENTS`, `MAX_METADATA_SIZE_BYTES`, `MAX_RETRIEVAL_OPERATIONS`, `MAX_DEPENDENCY_DEPTH`, `MAX_ORG_VERIFICATION_AGE_MS`, `VALIDATION_EXPIRY_MINUTES`, `COMPONENT_LOCK_LEASE_SECONDS`, and `COMPONENT_LOCK_HEARTBEAT_MS`. `DISPATCHER_POLL_INTERVAL_MS` and `DISPATCHER_MAX_PER_SCAN` optionally tune the outbox.

`TEST_DATABASE_URL` is test-only and must identify the dedicated `_test` database. `REDISMS_PORT` is for the local Redis launcher; `NGROK_AUTHTOKEN` is optional for `npm run tunnel`.

Jira is not required. Keep `JIRA_ENABLED=false` (the default). Only a deliberately enabled legacy integration uses `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_AGENT_ACCOUNT_ID`, `JIRA_WEBHOOK_SECRET`, `JIRA_ALLOWED_PROJECT_KEYS`, and `JIRA_POLL_INTERVAL_SECONDS`. `ALLOW_PRODUCTION_DEPLOYMENT` defaults false and remains false for Phase 1 operation.

## Startup order

1. `cd middleware; docker compose up -d postgres redis`
2. `npm.cmd run migrate`
3. Start the API/outbox dispatcher: `npm.cmd start`
4. In another shell with identical database, Redis, registry, project, and workspace settings: `npm.cmd run worker`
5. Verify `/health` and `/ready` through the trusted gateway.
6. Configure Salesforce, then expose the LWC.

API and worker both use PostgreSQL. `QUEUE_DRIVER=memory` is test/development-only; a non-test worker refuses it. Redis failure stays in the durable outbox and never causes inline execution.

## Salesforce

Authenticate and verify an explicitly selected development sandbox:

```powershell
$env:PHASE1_SALESFORCE_ALIAS='your-development-sandbox-alias'
sf org display --target-org $env:PHASE1_SALESFORCE_ALIAS --json
```

The registry entry must match observed org ID, username, instance URL, environment, authentication status, allowed operations/types, and deployment policy. Never rely on a default org.

Apex calls `callout:Agent_Middleware`. The checked-in legacy Named Credential contains no secret. For operation, configure a modern Named Credential with that API name plus a Named Principal External Credential—or an equivalent identity-aware gateway/mTLS layer—to send `Authorization: Bearer <MIDDLEWARE_API_TOKEN>`. Populate the principal only in Salesforce Setup; no External Credential secret is checked in. The endpoint must be reachable over HTTPS.

Assign `AI_Agent_User` for app/tab/Apex access. Assign `AI_Agent_Executor` only to approvers; it grants `AI_Agent_Admin` for implementation approval and `AI_Agent_Deploy` for deployment approval. Add `agentChat` to the intended Lightning page.

## Tests and dry run

```powershell
cd middleware
$env:TEST_DATABASE_URL='postgres://providus:providus@127.0.0.1:5432/providus_nexus_test'
npm.cmd run check
node --import ./test/setup.js --test test/recurringDonationVerticalSlice.test.js
cd ..
npm.cmd run test:unit
```

After safely verifying the alias, run only the non-destructive check:

```powershell
sf project deploy start --dry-run --source-dir force-app --test-level RunSpecifiedTests --tests AgentControllerTest --target-org $env:PHASE1_SALESFORCE_ALIAS --wait 30
```

Never remove `--dry-run`, quick deploy this validation, or activate generated Flow metadata.

## Troubleshooting

- PostgreSQL/migrations: check `docker compose ps`, the exact database URL, then rerun migrations. Required DB tests fail rather than skip.
- Redis: restore it and let the dispatcher retry; never switch production to memory or execute inline.
- Salesforce alias/auth: rerun read-only `sf org display` and reauthenticate the explicit sandbox. Do not deploy to test access.
- Named Credential 401: verify endpoint and bearer mapping without logging the secret.
- Same-org mismatch: update the registry only after independently verifying org ID, username, and instance URL.
- Approval expired/stale: refresh and approve the current plan or validation; never reuse old authority.
- Lease loss: stop and investigate current owner/expiry instead of bypassing fencing.
- Dry-run failure: retain safe evidence and do not convert it to a live deployment.
- Jira disabled: normal for direct chat; Jira routes/actions are absent until deliberately enabled.
