# Setup

## Jira-to-org routing

Every connected Salesforce org is registered in `middleware/config/org-registry.json`. Automatic ticket routing uses only configured Jira project keys, components, and custom-field values. Ticket descriptions, comments, aliases, usernames, URLs, and credentials are never org-selection inputs.

Use a unique project mapping when one Jira project belongs to one org:

```json
"jiraProjectKeys": ["SAPA"]
```

When a project serves multiple orgs, configure a Jira component or a dedicated single-select custom field on each registry entry:

```json
"jiraComponents": ["Development"],
"jiraCustomFieldMappings": {
  "customfield_10001": ["SAPA Dev Sandbox"]
}
```

All configured routing signals must agree. Zero or multiple matches put the job in `AWAITING_ORG_SELECTION`; no Salesforce inspection or execution starts until an authenticated user selects an offered connected org. Every subsequent Salesforce command reverifies the alias, Organization ID, instance URL, username, and environment, and includes an explicit `--target-org`.

## Jira

1. Create a least-privilege Jira service account and record its account ID.
2. Set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_AGENT_ACCOUNT_ID`, `JIRA_WEBHOOK_SECRET`, and `JIRA_ALLOWED_PROJECT_KEYS` only in the middleware secret store.
3. Register a Jira admin webhook for `jira:issue_created` and `jira:issue_updated`, filtered to the allowed project, and set its URL to `POST /api/webhooks/jira`. Set the webhook `secret` to `JIRA_WEBHOOK_SECRET`; Jira sends the resulting HMAC in `X-Hub-Signature`.
4. The middleware verifies the raw-body HMAC, allowed project, and configured assignee before accepting an event. Jira Automation remains an optional fallback using a hidden `X-Agent-Webhook-Token` header.
5. Jira transition automation is intentionally disabled by default; successful deployment adds a comment but does not close the issue.

For local testing, set `NGROK_AUTHTOKEN` in the middleware secret store and run `npm run tunnel`. The launcher relies on ngrok's environment-based authentication so the token is not exposed in process arguments.

## Org Registry

Copy the inactive example in `middleware/config/org-registry.json`. Replace the alias, exact 15/18-character Organization ID, canonical instance URL, project/component mappings, workspace, metadata policies, and deployment policy. Confirm `sf org display --target-org <alias> --json`, then set `active: true`. Record create/update capability must also set `dataMutationPermission`, `allowedDataObjects`, `maximumDataOperations`, and the exact `data-create`/`data-update` operations. Never store OAuth tokens or session IDs in this file.

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
6. The worker reverifies identity and hashes, then deploys the exact manifest or executes only the approved structured record operations. It records deployment or record IDs and comments on Jira.

## Remaining Manual Steps

- Initialize or restore the Git repository; the current `.git` directory is empty, so implementation correctly fails closed at branch creation.
- Configure real org registry entries and authenticate each alias on the worker host.
- Configure HTTPS, gateway authentication, request throttling, centralized logs, backups, and a production-grade secret manager.
- Configure the Named Credential/External Credential principal and permission sets in Salesforce.
- Configure the Jira webhook HMAC gateway and service-account permissions.
- Install the Codex CLI on the middleware worker and run `codex login`. The middleware uses an ephemeral, read-only Codex execution with schema-constrained output; it does not require or expose an OpenAI API key. Keep `AGENT_BACKEND=codex`.
