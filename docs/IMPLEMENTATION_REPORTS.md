# Implementation Reports

## Overview

After every successful Salesforce deployment, the Documentation Agent creates one consultant-quality Implementation Report from the approved Jira requirement, plan, validation result, deployed component summary, user instructions, and deployment history.

The report is generated in three formats from the same canonical snapshot:

- PDF
- Microsoft Word (`.docx`)
- Markdown (`.md`)

The report is not created for failed deployments or jobs where no deployment was required. It never contains raw execution logs, credentials, internal hashes, validation or deployment identifiers, XML, hidden reasoning, or filesystem paths.

## Versioning

Deployment versions count successful deployments, independently from plan versions. The first successful deployment creates Implementation Report V1. A later approved follow-up deployment creates V2 without changing V1.

Descriptors are stored in the job's append-only `implementationReports` and `deploymentHistory` collections. Files are stored under:

```text
jobs/<jobId>/deployment/reports/v<deploymentVersion>/
```

Each version contains the three downloads, a canonical `report.json`, and an integrity manifest. Existing report directories are immutable. The middleware verifies the recorded file size and SHA-256 digest before returning a download.

## Salesforce Downloads

The LWC displays **Implementation Report Ready** and three download buttons for every ready deployment version. Apex retrieves the selected file through the existing `Agent_Middleware` Named Credential and returns Base64 content to the LWC. Middleware credentials are never sent to the browser.

The download endpoint is restricted to the Salesforce Organization ID associated with the job:

```text
GET /api/jobs/:jobId/implementation-reports/:deploymentVersion/:format
```

Allowed formats are `pdf`, `docx`, and `markdown`.

## Optional Logo

Set `IMPLEMENTATION_REPORT_LOGO_PATH` to a PNG or JPEG located inside `PROJECT_ROOT`. Jira URLs and external image URLs are not accepted. If the file is missing or invalid, the report is generated without a logo.

`MAX_IMPLEMENTATION_REPORT_BYTES` limits each raw download before Base64 encoding. The default is 1 MB to remain within Salesforce Apex response and heap limits.

## Storage Limitation

The current implementation uses the local isolated `jobs/` workspace. It survives Redis restarts and plan revisions, but it is not production-grade permanent storage by itself. Production installations must back up this directory or replace it with encrypted, versioned object storage such as Azure Blob Storage, Amazon S3, or Google Cloud Storage.
