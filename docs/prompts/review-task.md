# Review One Phase 1 Task

Replace `TASK_NUMBER` and `COMMIT_SHA` once before sending this prompt.

```text
Review Phase 1 Task TASK_NUMBER at commit COMMIT_SHA on branch feature/providus-phase1-execution.

Read AGENTS.md, docs/progress.md, the selected plan task, relevant design sections, and only changed or directly dependent files.

Check:
- requirement and acceptance-criteria coverage;
- correctness and regressions;
- tests and verification evidence;
- untrusted-input handling;
- exact-org enforcement;
- command and metadata allowlists;
- separate implementation and deployment approvals;
- credentials and sensitive-data exposure;
- idempotency and duplicate processing;
- concurrency and file ownership;
- rollback and failure-state behavior;
- unnecessary scope or unrelated refactoring.

Report findings first, ordered by severity, with file paths and concrete fixes.
If there are no findings, state that clearly and list residual risks or unverified areas.
Do not edit files unless explicitly asked to address the findings.
```
