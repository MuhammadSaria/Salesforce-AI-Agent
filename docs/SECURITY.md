# Security Model and Limits

- Every Salesforce CLI operation reverifies alias, Organization ID, and instance URL and supplies `--target-org` explicitly.
- CLI and Git commands use fixed argument arrays with `shell: false`; shell operators, output redirection, destructive Git, record deletion, and broad destructive metadata are unavailable. Structured record creates and updates are available only for registry-allowlisted objects and operations after validation and a separate execution approval.
- Jira aliases, usernames, URLs, credentials, comments, attachments, Salesforce records, and prompts cannot select an org or authorize a stage.
- Implementation and deployment approvals are separate, explicit, versioned, actor-attributed records. Production requires a production flag plus the server-side production feature flag.
- Retrieval and deployment use a job-specific manifest within an isolated workspace. Component/depth/operation limits stop uncontrolled expansion.
- Logs redact authorization values, API keys, token fields, and long token-like strings.

Current limitations: Redis references are application-enforced rather than SQL foreign keys; JSONL audit files are append-only by application convention rather than tamper-proof storage; one shared middleware bearer token is suitable only behind a trusted Salesforce/API gateway; attachment contents are not downloaded; cross-org comparison has policy fields but no dedicated two-org execution workflow; Jira status transitions are not enabled; multi-record execution is not transactional and can partially succeed; AI-generated source and record values still require human review and Salesforce validation; and no production execution should be enabled until Git, identity-aware authorization, durable audit storage, backups, rate limiting, and operational review are configured.
