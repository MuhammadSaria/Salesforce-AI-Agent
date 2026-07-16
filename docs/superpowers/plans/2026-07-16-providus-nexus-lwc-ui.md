# Providus Nexus LWC UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the existing `agentChat` Lightning Web Component as a professional, interactive Salesforce delivery workspace branded as Providus Nexus.

**Architecture:** Keep the existing Apex methods, job payload, polling, state machine, approvals, and deployment behavior unchanged. Add client-side presentation getters for a five-stage workflow and current action, render a custom Salesforce-native workspace shell, and add a local disclosure control for specialist detail. Preserve every existing action handler while improving the template, CSS, component metadata label, and Jest coverage.

**Tech Stack:** Salesforce Lightning Web Components, Salesforce Lightning Design System base components, Apex imports already used by `agentChat`, CSS, Jest with `@salesforce/sfdx-lwc-jest`.

## Global Constraints

- Use `Providus Nexus` as the visible component name and metadata master label.
- Keep specialist details collapsed by default.
- Preserve the current Apex methods and middleware response structures.
- Preserve separate implementation and deployment approvals.
- Keep production, data-change, destructive-action, and validation-failure warnings visible.
- Keep instructions available in every non-cancelled job state.
- Do not reintroduce a chat interface.
- Do not deploy this UI to a Salesforce org during implementation.

---

## File Structure

- Modify `force-app/main/default/lwc/agentChat/agentChat.js`: derive the five workflow stages, current-action content, specialist summary, disclosure state, and workspace refresh behavior.
- Modify `force-app/main/default/lwc/agentChat/agentChat.html`: render the Providus Nexus header, compact job workspace, verified-org context, five-stage progress, current-action panel, collapsible specialist section, and contextual action footer.
- Modify `force-app/main/default/lwc/agentChat/agentChat.css`: implement the restrained Salesforce-native visual system, semantic states, responsive grids, disclosure interaction, and accessible focus treatment.
- Modify `force-app/main/default/lwc/agentChat/agentChat.js-meta.xml`: expose the component with the master label `Providus Nexus` and a concise description.
- Modify `force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js`: add branding, progress, disclosure, current-action, and refresh tests while retaining the existing regression suite.

### Task 1: Providus Nexus Workspace And Five-Stage Progress

**Files:**
- Modify: `force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.js`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.html`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.css`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.js-meta.xml`

**Interfaces:**
- Consumes: existing `job.status`, `job.currentActivity`, `job.orgContext`, `job.implementation`, `job.validation`, and `job.deployment` values.
- Produces: `workflowStages: Array<{ key, label, detail, iconName, className, ariaCurrent }>` and the visible Providus Nexus workspace regions used by Task 2.

- [ ] **Step 1: Add failing branding and five-stage progress tests**

Add these cases to `agentChat.test.js` using the existing Apex mocks and helper functions:

```javascript
it('brands the workspace as Providus Nexus', async () => {
    const element = createElement('c-agent-chat', { is: AgentChat });
    document.body.appendChild(element);
    await flushPromises();

    expect(element.shadowRoot.querySelector('.nexus-brand__name').textContent).toBe('Providus Nexus');
    expect(element.shadowRoot.textContent).not.toContain('Salesforce In-Org AI Agent');
    expect(element.shadowRoot.querySelector('.empty-state').textContent).toContain('Select an assigned Jira task');
});

it('shows a five-stage workflow with the current stage emphasized', async () => {
    const job = {
        jobId: 'job-progress', status: 'AWAITING_PLAN_APPROVAL', approvals: [], logs: [],
        orgContext: { customerName: 'Providus', displayName: 'Developer Org', environment: 'developer', expectedOrgId: '00D000000000001', verified: { verifiedAt: '2026-07-16T10:00:00Z' } },
        plan: { planVersion: 1 }, metadataScope: { primaryMetadata: [], dependencies: [] }
    };
    getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
    getAgentJob.mockResolvedValue(JSON.stringify(job));

    const element = createElement('c-agent-chat', { is: AgentChat });
    document.body.appendChild(element);
    await flushPromises();

    const stages = [...element.shadowRoot.querySelectorAll('.workflow-stage')];
    expect(stages).toHaveLength(5);
    expect(stages.map((stage) => stage.textContent)).toEqual(expect.arrayContaining([
        expect.stringContaining('Analysis'),
        expect.stringContaining('Plan'),
        expect.stringContaining('Implementation'),
        expect.stringContaining('Validation'),
        expect.stringContaining('Deployment')
    ]));
    expect(element.shadowRoot.querySelector('.workflow-stage--active').textContent).toContain('Plan');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
cmd /c npm run test:unit -- --runInBand --testNamePattern="brands the workspace|five-stage workflow"
```

Expected: both new tests fail because `.nexus-brand__name`, `.empty-state`, and `.workflow-stage` do not exist.

- [ ] **Step 3: Add deterministic workflow-stage derivation**

In `agentChat.js`, define the ordered stage configuration above the component class and add `workflowStages` plus helper methods. Use the existing detailed milestone text for implementation, validation, and deployment so current regression expectations remain valid.

```javascript
const WORKFLOW_STAGES = [
    { key: 'analysis', label: 'Analysis' },
    { key: 'plan', label: 'Plan' },
    { key: 'implementation', label: 'Implementation' },
    { key: 'validation', label: 'Validation' },
    { key: 'deployment', label: 'Deployment' }
];

get workflowStages() {
    const activeIndex = this.workflowStageIndex;
    return WORKFLOW_STAGES.map((stage, index) => {
        const failed = this.failedWorkflowStage === stage.key;
        const complete = !failed && (this.status === 'COMPLETED' || index < activeIndex);
        const active = !failed && this.status !== 'COMPLETED' && index === activeIndex;
        return {
            ...stage,
            detail: this.workflowStageDetail(stage.key),
            iconName: failed ? 'utility:error' : complete ? 'utility:success' : active ? 'utility:sync' : 'utility:clock',
            className: `workflow-stage${failed ? ' workflow-stage--failed' : complete ? ' workflow-stage--complete' : active ? ' workflow-stage--active' : ''}`,
            ariaCurrent: active ? 'step' : null
        };
    });
}
```

Map states explicitly in `workflowStageIndex`: analysis states to `0`, `AWAITING_PLAN_APPROVAL` and `PLAN_REJECTED` to `1`, `IMPLEMENTING` to `2`, `VALIDATING`, `VALIDATION_FAILED`, and `AWAITING_DEPLOYMENT_APPROVAL` to `3`, and `DEPLOYING` or `COMPLETED` to `4`. Map `ORG_VERIFICATION_FAILED` and generic pre-implementation `FAILED` to a failed analysis stage, `PLAN_REJECTED` to a failed plan stage, and `VALIDATION_FAILED` to a failed validation stage.

- [ ] **Step 4: Replace the generic card shell with the Providus Nexus workspace**

In `agentChat.html`, replace the outer `lightning-card` with a semantic shell that keeps the existing toolbar and all job content:

```html
<section class="nexus-shell" aria-labelledby="nexus-title">
    <header class="nexus-header">
        <div class="nexus-brand">
            <span class="nexus-brand__icon"><lightning-icon icon-name="standard:work_order" size="small" alternative-text="Providus Nexus"></lightning-icon></span>
            <div>
                <h1 id="nexus-title" class="nexus-brand__name">Providus Nexus</h1>
                <p class="nexus-brand__subtitle">Salesforce delivery workspace</p>
            </div>
        </div>
        <div class="nexus-header__status">
            <template if:true={hasJob}><lightning-badge label={statusDisplay}></lightning-badge></template>
            <lightning-button-icon icon-name="utility:refresh" alternative-text="Refresh workspace" title="Refresh workspace" onclick={handleReload} disabled={isBusy}></lightning-button-icon>
        </div>
    </header>
    <template if:true={isBusy}><lightning-spinner alternative-text="Providus Nexus is working" size="small"></lightning-spinner></template>
    <div class="console">
        <!-- Preserve the existing toolbar, warnings, details, instructions, and actions here. -->
    </div>
</section>
```

When `hasJob` is false, render `.empty-state` after the toolbar with `utility:work_order_type`, a heading `Start with a Jira task`, and text `Select an assigned Jira task or provide a Jira key and instruction to begin.`

Replace the three-item milestone markup with:

```html
<ol class="milestones workflow-progress" aria-label="Delivery progress">
    <template for:each={workflowStages} for:item="stage">
        <li class={stage.className} key={stage.key} aria-current={stage.ariaCurrent}>
            <lightning-icon icon-name={stage.iconName} size="x-small" alternative-text={stage.label}></lightning-icon>
            <div><strong>{stage.label}</strong><span>{stage.detail}</span></div>
        </li>
    </template>
</ol>
```

- [ ] **Step 5: Add the professional workspace styles and metadata identity**

In `agentChat.css`, replace the generic outer rules with a neutral shell, a white header band, a compact brand lockup, and a five-column progress grid. Preserve semantic success, warning, and failure colors.

```css
:host { display: block; color: #181818; }
.nexus-shell { position: relative; background: #f7f9fb; border: 1px solid #d8dde6; min-height: 18rem; }
.nexus-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; min-height: 4.5rem; padding: .875rem 1rem; background: #fff; border-bottom: 1px solid #d8dde6; box-shadow: 0 1px 2px rgba(24, 24, 24, .06); }
.nexus-brand { display: flex; align-items: center; gap: .75rem; min-width: 0; }
.nexus-brand__icon { display: grid; place-items: center; width: 2.5rem; height: 2.5rem; background: #eef4ff; border: 1px solid #b8d5f2; border-radius: .25rem; }
.nexus-brand__name { margin: 0; font-size: 1.25rem; font-weight: 700; line-height: 1.25; }
.nexus-brand__subtitle { margin: .125rem 0 0; color: #444; font-size: .8125rem; }
.nexus-header__status { display: flex; align-items: center; gap: .5rem; }
.workflow-progress { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); padding: 0; list-style: none; }
.workflow-stage { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr); gap: .5rem; min-height: 4.25rem; padding: .75rem; background: #fff; border-right: 1px solid #d8dde6; }
.workflow-stage--active { background: #eef4ff; box-shadow: inset 0 3px 0 #0176d3; }
.workflow-stage--complete { background: #eef8f1; box-shadow: inset 0 3px 0 #2e844a; }
.workflow-stage--failed { background: #fef1ee; box-shadow: inset 0 3px 0 #ba0517; }
```

In `agentChat.js-meta.xml`, add:

```xml
<masterLabel>Providus Nexus</masterLabel>
<description>Supervised Salesforce delivery workspace for Jira-driven implementation, validation, and deployment.</description>
```

- [ ] **Step 6: Run the focused tests and verify they pass**

Run:

```powershell
cmd /c npm run test:unit -- --runInBand --testNamePattern="brands the workspace|five-stage workflow"
```

Expected: 2 tests pass.

- [ ] **Step 7: Commit Task 1**

```powershell
git add -- force-app/main/default/lwc/agentChat/agentChat.html force-app/main/default/lwc/agentChat/agentChat.js force-app/main/default/lwc/agentChat/agentChat.css force-app/main/default/lwc/agentChat/agentChat.js-meta.xml force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js
git commit -m "Refresh Providus Nexus workspace UI"
```

### Task 2: Current Action And Collapsible Specialist Delivery

**Files:**
- Modify: `force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.js`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.html`
- Modify: `force-app/main/default/lwc/agentChat/agentChat.css`

**Interfaces:**
- Consumes: `statusDisplay`, existing state-based action getters, `specialistWorkItems`, `specialistOverallStatus`, and `orchestrationIteration`.
- Produces: `currentAction`, `specialistsExpanded`, `specialistToggleIcon`, `specialistProgressSummary`, `handleToggleSpecialists()`, and `handleReload()`.

- [ ] **Step 1: Add failing disclosure, action, and refresh tests**

Add tests that build an `AWAITING_PLAN_APPROVAL` job with two specialist work items, then assert:

```javascript
expect(element.shadowRoot.querySelector('.current-action').textContent).toContain('Review the implementation plan');
expect(element.shadowRoot.querySelector('.specialist-list')).toBeNull();
expect(buttonByTitle(element, 'Show specialist details').getAttribute('aria-expanded')).toBe('false');

buttonByTitle(element, 'Show specialist details').click();
await flushPromises();

expect(element.shadowRoot.querySelector('.specialist-list').textContent).toContain('Object and Field Agent');
expect(buttonByTitle(element, 'Hide specialist details').getAttribute('aria-expanded')).toBe('true');
```

Add a refresh test that clicks the `Refresh workspace` icon and expects `getJobs` and `getAgentJob` to be called again without invoking `performJobAction`.

Add this helper:

```javascript
function buttonByTitle(element, title) {
    return [...element.shadowRoot.querySelectorAll('lightning-button-icon')].find((button) => button.title === title);
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
cmd /c npm run test:unit -- --runInBand --testNamePattern="current action|specialist details|refreshes the workspace"
```

Expected: the tests fail because the current-action panel and disclosure/refresh handlers do not exist.

- [ ] **Step 3: Implement current-action and specialist disclosure state**

In `agentChat.js`, add `specialistsExpanded = false`, reset it in `selectJob`, and implement:

```javascript
get currentAction() {
    const actions = {
        AWAITING_ORG_SELECTION: { title: 'Select the target Salesforce org', message: 'Choose one verified org before analysis can continue.', iconName: 'utility:company', tone: 'attention' },
        AWAITING_PLAN_APPROVAL: { title: 'Review the implementation plan', message: 'Confirm the proposed business outcome, scope, tests, and rollback approach before approving implementation.', iconName: 'utility:approval', tone: 'attention' },
        IMPLEMENTING: { title: 'Applying the approved changes locally', message: 'Providus Nexus is updating only the approved files. Nothing is being deployed yet.', iconName: 'utility:settings', tone: 'active' },
        VALIDATING: { title: 'Validating the implementation', message: 'Salesforce validation and relevant tests are running against the verified target org.', iconName: 'utility:test', tone: 'active' },
        VALIDATION_FAILED: { title: 'Validation needs attention', message: this.validationFailureReason, iconName: 'utility:error', tone: 'error' },
        AWAITING_DEPLOYMENT_APPROVAL: { title: this.hasDeploymentApproval ? 'Approved deployment is ready' : 'Review validation and approve deployment', message: this.hasDeploymentApproval ? 'The validated package can now be deployed to the exact approved org.' : 'Implementation approval does not authorize deployment. Review the validation result before deciding.', iconName: 'utility:upload', tone: 'attention' },
        DEPLOYING: { title: 'Deploying the approved package', message: 'Providus Nexus is deploying only the validated components to the verified target org.', iconName: 'utility:upload', tone: 'active' },
        COMPLETED: { title: this.deploymentNotRequired ? 'Work completed without deployment' : 'Deployment completed', message: this.deploymentNotRequired ? 'Validation confirmed that no Salesforce deployment was required.' : this.deploymentSummaryText, iconName: 'utility:success', tone: 'success' }
    };
    return actions[this.status] || { title: this.statusDisplay, message: 'Providus Nexus is preparing the next supervised step.', iconName: 'utility:clock', tone: 'active' };
}
get currentActionClass() { return `current-action current-action--${this.currentAction.tone}`; }
get specialistToggleIcon() { return this.specialistsExpanded ? 'utility:chevronup' : 'utility:chevrondown'; }
get specialistToggleTitle() { return this.specialistsExpanded ? 'Hide specialist details' : 'Show specialist details'; }
get specialistProgressSummary() { return `${this.specialistWorkItems.length} specialists | Iteration ${this.orchestrationIteration}`; }
handleToggleSpecialists() { this.specialistsExpanded = !this.specialistsExpanded; }
async handleReload() { await this.run(async () => { await this.refreshJobs(); if (this.hasJob) await this.refreshJob(); }); }
```

- [ ] **Step 4: Render the current-action panel and disclosure**

Render `.current-action` immediately after workflow progress. Replace the always-expanded specialist block with a disclosure header whose button uses `aria-expanded={specialistsExpanded}`, `title={specialistToggleTitle}`, and `onclick={handleToggleSpecialists}`. Render `.specialist-list` only inside `<template if:true={specialistsExpanded}>`.

Use visible copy `Specialist delivery progress` and `Providus Nexus coordinates these specialist results into one implementation plan and one approval.` Do not display `Orchestrator Agent` as the product identity.

- [ ] **Step 5: Style the action panel, disclosure, and contextual footer**

Add semantic left borders for `.current-action--active`, `--attention`, `--success`, and `--error`. Give `.specialist-progress__heading` a hover background and visible `:focus-within` outline. Convert `.actions` into a sticky-looking contextual footer using `position: sticky; bottom: 0; background: rgba(255, 255, 255, .97);` only for viewports wider than `48rem`; on smaller screens return it to normal document flow.

- [ ] **Step 6: Run the focused tests and verify they pass**

Run:

```powershell
cmd /c npm run test:unit -- --runInBand --testNamePattern="current action|specialist details|refreshes the workspace"
```

Expected: all new Task 2 tests pass.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- force-app/main/default/lwc/agentChat/agentChat.html force-app/main/default/lwc/agentChat/agentChat.js force-app/main/default/lwc/agentChat/agentChat.css force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js
git commit -m "Add interactive Providus Nexus delivery controls"
```

### Task 3: Responsive And Regression Verification

**Files:**
- Modify: `force-app/main/default/lwc/agentChat/agentChat.css`
- Modify: `force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js` only if an existing regression expectation must target the new semantic region.

**Interfaces:**
- Consumes: the completed Providus Nexus workspace from Tasks 1 and 2.
- Produces: a responsive App Page, Home Page, and Record Page presentation with the full existing Jest suite passing.

- [ ] **Step 1: Run the complete LWC Jest suite**

Run:

```powershell
cmd /c npm run test:unit -- --runInBand
```

Expected: all original and new `agentChat` tests pass. If an original test fails only because a class moved, update the query to the equivalent new semantic region without weakening its behavior assertion.

- [ ] **Step 2: Complete responsive rules**

Verify and add exact breakpoints:

```css
@media (max-width: 64rem) {
    .toolbar { grid-template-columns: 1fr 1fr; }
    .identity-bar { grid-template-columns: repeat(2, minmax(8rem, 1fr)); }
    .workflow-progress { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 48rem) {
    .nexus-header { align-items: flex-start; }
    .workflow-progress { grid-template-columns: 1fr; }
    .workflow-stage { border-right: 0; border-bottom: 1px solid #d8dde6; }
    .actions { position: static; }
    .deployment-table__header { display: none; }
    .deployment-table__row { grid-template-columns: 1fr; }
}
@media (max-width: 40rem) {
    .nexus-header { flex-direction: column; }
    .toolbar, .action-band, .instruction-band, .identity-bar, .specialist-row { grid-template-columns: 1fr; }
    .instruction-actions, .actions { align-items: stretch; flex-direction: column; }
    .details { grid-template-columns: 1fr; }
}
```

Ensure long Jira summaries, Organization IDs, API names, validation failures, and button labels wrap without overlapping adjacent content.

- [ ] **Step 3: Run static verification**

Run:

```powershell
cmd /c npm run test:unit -- --runInBand
git diff --check -- force-app/main/default/lwc/agentChat
```

Expected: the complete Jest suite passes and `git diff --check` reports no whitespace errors. CRLF conversion warnings are acceptable on Windows.

- [ ] **Step 4: Review the scoped diff**

Run:

```powershell
git diff -- force-app/main/default/lwc/agentChat
```

Confirm that the diff contains only presentation-derived state, markup, styles, metadata label, and tests. Confirm there are no changes to Apex imports, Apex method arguments, approval conditions, org verification, or deployment execution.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- force-app/main/default/lwc/agentChat/agentChat.css force-app/main/default/lwc/agentChat/__tests__/agentChat.test.js
git commit -m "Verify responsive Providus Nexus experience"
```

## Completion Criteria

- Providus Nexus is the only primary product identity in the component.
- The workspace shows five delivery stages with complete, active, pending, and failed states.
- The current required action is prominent and human-readable.
- Specialist details are collapsed by default and expand on demand.
- All existing approval, instruction, validation, deployment, and report behaviors remain intact.
- All LWC Jest tests pass.
- No Salesforce org deployment has occurred.
