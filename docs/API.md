# API Contract

All `/api/*` routes except the Jira webhook require `Authorization: Bearer <MIDDLEWARE_API_TOKEN>`. Salesforce supplies actor identity in `X-Agent-User-Id`; the Apex controller derives `developer` or `deployer` from the `AI_Agent_Deploy` Custom Permission. Put an identity-aware gateway in front of the API for production deployments.

## Routes

- `POST /api/webhooks/jira`: Jira event authenticated by a constant-time checked hidden webhook token or HMAC signature, fast `202`, idempotent async processing.
- `GET /api/orgs`, `GET /api/orgs/:orgId`: public policy fields for active registry orgs.
- `POST /api/jobs`, `GET /api/jobs`, `GET /api/jobs/:jobId`: create/list/read jobs.
- `POST /api/jobs/:jobId/select-org`: select only an active registry ID and invalidate old artifacts.
- `POST /api/jobs/:jobId/analyze`: queue safe inspection.
- `GET /api/jobs/:jobId/plan`: structured versioned plan.
- `POST /api/jobs/:jobId/instructions`: add untrusted requirements; approvals are invalidated.
- `POST /api/jobs/:jobId/approve-implementation`, `POST /api/jobs/:jobId/reject-plan`.
- `POST /api/jobs/:jobId/implement`: execute only approved local file operations.
- `POST /api/jobs/:jobId/validate`, `GET /api/jobs/:jobId/validation`.
- `GET /api/jobs/:jobId/diff`, `GET /api/jobs/:jobId/logs`, `GET /api/jobs/:jobId/audit`.
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
