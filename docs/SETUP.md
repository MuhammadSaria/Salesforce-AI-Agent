# Setup

## Jira

1. Create a least-privilege Jira service account and record its account ID.
2. Set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_AGENT_ACCOUNT_ID`, `JIRA_WEBHOOK_SECRET`, and `JIRA_ALLOWED_PROJECT_KEYS` only in the middleware secret store.
3. Configure Jira or an API gateway to send `POST /api/webhooks/jira` with `X-Agent-Webhook-Signature: sha256=<HMAC-SHA256(raw-body)>`.
4. Subscribe only to issue-created and issue-updated events. The middleware processes only allowed projects and issues assigned to the configured agent.
5. Jira transition automation is intentionally disabled by default; successful deployment adds a comment but does not close the issue.

## Org Registry

Copy the inactive example in `middleware/config/org-registry.json`. Replace the alias, exact 15/18-character Organization ID, canonical instance URL, project/component mappings, workspace, metadata policies, and deployment policy. Confirm `sf org display --target-org <alias> --json`, then set `active: true`. Never store OAuth tokens or session IDs in this file.

For production entries set `environment: production`, `productionApprovalRequired: true`, and enable `ALLOW_PRODUCTION_DEPLOYMENT=true` only after external change controls are ready.

## Named Credential and Apex

In Salesforce Setup, create a modern Named Credential named `Agent_Middleware` and a Named Principal External Credential. Set the HTTPS middleware endpoint and configure a generated `Authorization: Bearer <MIDDLEWARE_API_TOKEN>` header, or enforce equivalent identity at an API gateway/mTLS layer. Populate the principal secret in Salesforce Setup or through the Connect API; it is intentionally not checked into metadata. Grant the External Credential principal, Apex class access, and the LWC through a permission set. Grant `AI_Agent_Deploy` only to deployment approvers.

Salesforce recommends the modern Named Credential plus External Credential model because legacy Named Credentials are deprecated. Packaged credential metadata does not include sensitive tokens or certificates, so principal population remains a required post-deployment step.

The middleware URL must be HTTPS and reachable from Salesforce. The Apex proxy allows only fixed API actions and sends the current Salesforce user ID as audit identity.

## Example Flow

1. Jira assigns `READUSA-42` to the agent and sends a signed webhook.
2. Project/component mapping resolves `read_usa_sandbox`; `sf org display --target-org read-usa-sandbox --json` must match the stored Organization ID and URL.
3. The worker extracts exact metadata names, writes `jobs/<jobId>/manifest/package.xml`, retrieves only that scope, analyzes dependencies, and publishes plan version 1 with “No changes have been made yet.”
4. A developer clicks **Approve Implementation**, then **Implement Locally**. The worker creates `ai-agent/READUSA-42-<jobId>`, writes only approved files, and records a diff/source hash. It does not deploy.
5. Validation performs an exact-manifest dry run against the same org. A deployer separately clicks **Approve Deployment** and **Deploy Approved Package**.
6. The worker reverifies identity and hashes, deploys the exact manifest, records the deployment ID, and comments on Jira.

## Remaining Manual Steps

- Initialize or restore the Git repository; the current `.git` directory is empty, so implementation correctly fails closed at branch creation.
- Configure real org registry entries and authenticate each alias on the worker host.
- Configure HTTPS, gateway authentication, request throttling, centralized logs, backups, and a production-grade secret manager.
- Configure the Named Credential/External Credential principal and permission sets in Salesforce.
- Configure the Jira webhook HMAC gateway and service-account permissions.
- Enable `OPENAI_ENABLED=true` and configure `OPENAI_API_KEY` to generate constrained source proposals for review. With AI disabled, the deterministic planner intentionally produces no file writes.
