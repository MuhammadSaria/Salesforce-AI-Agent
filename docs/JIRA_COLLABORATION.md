# Providus Nexus Jira Collaboration

## Identity

Providus Nexus is the Salesforce engineer identity used in Jira. Every middleware-authored comment is prefixed with `Providus Nexus:` and passes through a comment-safety filter before it is sent.

Jira controls the visible comment author through the Atlassian account associated with `JIRA_EMAIL` and `JIRA_API_TOKEN`. Rename that account's display name to **Providus Nexus** in Atlassian account settings so both the author and comment content use the same identity.

## Conversation Behavior

The Jira poller continuously checks allowed projects for issues assigned to the configured account. New user comments are classified as:

- Requirement change
- Implementation constraint
- Bug report
- Question
- Explanation request
- Environment question
- Deployment scheduling request
- Social response

Questions, explanations, scheduling requests, and social comments receive a reply without changing the approved implementation. Requirement changes, constraints, and bug reports receive a reply and create a supervised plan revision.

Codex produces a contextual reply when it is available. A deterministic Salesforce-aware response is used if Codex is unavailable or returns unsafe content. Jira comments remain untrusted input and cannot authorize implementation, validation bypass, data changes, deployment, org changes, commands, or credential access.

## Progress Updates

Providus Nexus posts concise updates when:

- A ticket is picked up
- The implementation proposal is ready
- Approved implementation begins
- Validation begins
- Validation passes or fails
- Deployment succeeds or fails
- Review confirms no deployment is required

Implementation and deployment approvals still occur only in the Salesforce AI Agent. Detailed plans, specialist work items, validation errors, source differences, IDs, hashes, execution logs, and deployment history remain there rather than in Jira.

## Comment Safety

Before posting, Jira comments remove or reject:

- Job, plan, validation, and deployment identifiers
- Salesforce IDs
- Source and Git hashes
- Metadata scope and internal states
- Risk labels
- Salesforce DX file paths
- XML content
- Credentials and secret values

Providus Nexus comments are ignored by the synchronization poller so they cannot create response loops.

