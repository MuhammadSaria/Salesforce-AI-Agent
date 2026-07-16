# API Contract

All `/api/*` routes except the Jira webhook require `Authorization: Bearer <MIDDLEWARE_API_TOKEN>`. Salesforce supplies actor identity in `X-Agent-User-Id`; the Apex controller derives `developer` or `deployer` from the `AI_Agent_Deploy` Custom Permission. Put an identity-aware gateway in front of the API for production deployments.

## Routes

- `GET /health`: unauthenticated process liveness with no dependency or secret details.
- `GET /ready`: unauthenticated sanitized readiness booleans for the durable queue, worker heartbeat, Jira, middleware authentication, and Codex backend. When Jira polling is enabled, the Jira check reflects the latest completed poll; webhook-only mode checks configuration. Returns `503` until all checks pass.
- `POST /api/webhooks/jira`: Jira event authenticated by a constant-time checked hidden webhook token or HMAC signature, fast `202`, idempotent async processing.
- `GET /api/orgs`, `GET /api/orgs/:orgId`: public policy fields for active registry orgs.
- `POST /api/jobs`, `GET /api/jobs?limit=50&cursor=<opaque>`, `GET /api/jobs/:jobId`: create, paginate compact summaries, and read one detailed job. The list response also contains `nextCursor` and `total`.
- `POST /api/jobs/:jobId/select-org`: select only an active registry ID and invalidate old artifacts.
- `POST /api/jobs/:jobId/analyze`: queue safe inspection.
- `GET /api/jobs/:jobId/plan`: structured versioned plan.
- `POST /api/jobs/:jobId/instructions`: add untrusted requirements; approvals are invalidated.
- `POST /api/jobs/:jobId/approve-implementation`, `POST /api/jobs/:jobId/reject-plan`.
- `POST /api/jobs/:jobId/implement`: execute only approved local file operations.
- `POST /api/jobs/:jobId/validate`, `GET /api/jobs/:jobId/validation`.
- `GET /api/jobs/:jobId/diff`, `GET /api/jobs/:jobId/logs`, `GET /api/jobs/:jobId/audit`.
- `GET /api/jobs/:jobId/work-items`: sanitized specialist work items plus the calculated overall specialist status.
- `GET /api/jobs/:jobId/specialist-messages`: structured internal dependency, conflict, correction, and completion messages. Hidden reasoning and raw prompts are never returned.
- `GET /api/jobs/:jobId/implementation-reports/:deploymentVersion/:format`: returns an org-isolated PDF, Word, or Markdown implementation report as authenticated Base64 JSON. The format is restricted to `pdf`, `docx`, or `markdown`.
- `POST /api/jobs/:jobId/approve-deployment`, `POST /api/jobs/:jobId/reject-deployment`: the durable second approval used for metadata deployment or allowlisted record execution. The LWC labels this as data execution when the plan contains record operations.
- `POST /api/jobs/:jobId/deploy`: queues only a matching, unexpired validated package.
- `POST /api/jobs/:jobId/cancel`.

Implementation approval body:

```json
{ "planVersion": 1, "comments": "Reviewed" }
```

Deployment approval body:

```json
{ "validationId": "validation-id", "productionSpecificApproval": false, "comments": "Validated package reviewed" }
```

Errors use `{ "error": { "code": "...", "message": "..." } }`. Secrets, raw Authorization headers, and Jira credentials are never returned.

The standard `GET /api/jobs/:jobId` response also contains `iteration`, `orchestration`, `workItems`, `specialistOverallStatus`, `deploymentHistory`, and safe `implementationReports` descriptors. Report bytes, raw attachment text, hashes, and filesystem paths are excluded. The Salesforce LWC displays specialist names, responsibilities, statuses, and versioned report downloads while preserving one implementation approval and one deployment approval.
