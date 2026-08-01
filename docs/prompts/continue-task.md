# Continue One Phase 1 Task

Replace `TASK_NUMBER` once before sending this prompt.

```text
Continue Providus Nexus on branch feature/providus-phase1-execution.

Work only on Phase 1 Task TASK_NUMBER.

Read:
1. AGENTS.md
2. docs/progress.md
3. docs/decisions.md
4. Only Task TASK_NUMBER in docs/plans/phase-1-implementation-plan.md
5. Only relevant sections of docs/specifications/phase-1-design.md
6. Directly related source and test files

Do not summarize the whole repository or unrelated tasks.
Use targeted searches and focused tests while implementing.
Run the task's required completion verification.
Review the final diff for correctness, regressions, and security.
Update docs/progress.md in the task checkpoint.
Commit and push all coherent completed work before stopping.
Do not deploy unless Task TASK_NUMBER explicitly requires deployment and all existing approvals pass.

Return only:
- Status
- Commit SHA
- Tests and results
- Blockers
- Next task
```
