import { createElement } from 'lwc';
import AgentChat from 'c/agentChat';
import getJobs from '@salesforce/apex/AgentController.getJobs';
import getOrgs from '@salesforce/apex/AgentController.getOrgs';
import getAgentJob from '@salesforce/apex/AgentController.getAgentJob';
import createAgentJob from '@salesforce/apex/AgentController.createAgentJob';
import performJobAction from '@salesforce/apex/AgentController.performJobAction';
import getImplementationReport from '@salesforce/apex/AgentController.getImplementationReport';

jest.mock('@salesforce/apex/AgentController.getJobs', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.getOrgs', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.getAgentJob', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.createAgentJob', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.performJobAction', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.getImplementationReport', () => ({ default: jest.fn() }), { virtual: true });

describe('c-agent-chat', () => {
    beforeEach(() => {
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [] }));
        getOrgs.mockResolvedValue(JSON.stringify({ orgs: [] }));
        createAgentJob.mockResolvedValue(JSON.stringify({ jobId: 'job-1', status: 'RECEIVED' }));
    });

    afterEach(() => {
        while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
        jest.clearAllMocks();
    });

    it('renders the supervised job entry controls without chat UI', async () => {
        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();
        expect(element.shadowRoot.querySelector('lightning-input')).not.toBeNull();
        expect(element.shadowRoot.querySelector('lightning-textarea')).not.toBeNull();
        expect(buttonByLabel(element, 'Create Job')).not.toBeNull();
        expect(buttonByLabel(element, 'Send Question')).toBeUndefined();
    });

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

    it('shows production warning and keeps implementation and deployment as separate actions', async () => {
        const job = {
            jobId: 'job-1', status: 'AWAITING_PLAN_APPROVAL', approvals: [], logs: [],
            orgContext: { customerName: 'Customer', displayName: 'Production', environment: 'production', expectedOrgId: '00D000000000001', verified: { verifiedAt: '2026-07-13T00:00:00Z' } },
            plan: { planVersion: 1 }, metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));
        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();
        expect(element.shadowRoot.querySelector('.production-warning').textContent).toContain('Production Salesforce org');
        expect(buttonByLabel(element, 'Approve Implementation')).not.toBeNull();
        expect(buttonByLabel(element, 'Approve Deployment')).toBeUndefined();
    });

    it('shows completed-without-deployment state distinctly', async () => {
        const job = {
            jobId: 'job-no-deploy', status: 'COMPLETED', logs: [],
            orgContext: { displayName: 'Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            plan: { notice: 'No changes were required.' },
            validation: { validationId: 'validation-1', status: 'PASSED' },
            deployment: { notRequired: true, reason: 'No source changes were proposed.' },
            metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        const milestones = element.shadowRoot.querySelector('.milestones').textContent;
        expect(milestones).toContain('Completed without deployment');
        expect(milestones).toContain('No deployment was required');
        expect(element.shadowRoot.querySelector('.notice').textContent).toContain('Validation completed and no deployment was required');
    });

    it('shows deployment details after completion and keeps instructions available', async () => {
        const job = {
            jobId: 'job-complete', status: 'COMPLETED', logs: [],
            orgContext: { customerName: 'Customer', displayName: 'Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            plan: { notice: 'No changes were required.' },
            validation: { validationId: 'validation-1', status: 'PASSED' },
            deployment: {
                summary: 'Deployed 2 Salesforce metadata components successfully.',
                components: [
                    { displayName: 'Custom Field', apiName: 'Account.Customer_Reference__c', briefInfo: 'Added an external customer reference field.' },
                    { displayName: 'Flow', apiName: 'Account_Update_Contact_Flow', briefInfo: 'Updated the account workflow.' }
                ]
            },
            metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        expect(element.shadowRoot.querySelector('.deployment-summary').textContent).toContain('Deployment complete');
        expect(element.shadowRoot.querySelector('.deployment-summary').textContent).toContain('Account.Customer_Reference__c');
        expect(textareaByLabel(element, 'Request a change or add an instruction').disabled).toBe(false);
        expect(buttonByLabel(element, 'Send Instruction')).not.toBeUndefined();
    });

    it('keeps one unified specialist progress view collapsed until requested', async () => {
        const job = {
            jobId: 'job-specialists', status: 'AWAITING_PLAN_APPROVAL', approvals: [], logs: [], iteration: 2, specialistOverallStatus: 'PROPOSAL_COMPLETE',
            orgContext: { customerName: 'Customer', displayName: 'Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            plan: { planVersion: 2, proposedImplementation: 'Add and automate Donor Status.' },
            workItems: [
                { workItemId: 'object-item', agentName: 'Object and Field Agent', status: 'PROPOSAL_COMPLETE', outputs: { analysisSummary: 'Owns the Contact field change.', proposedChanges: ['Create Donor Status.'] } },
                { workItemId: 'flow-item', agentName: 'Flow Agent', status: 'WAITING_FOR_DEPENDENCY', outputs: { analysisSummary: 'Owns the Contact automation.', proposedChanges: ['Set Donor Status automatically.'] } }
            ],
            metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        const progress = element.shadowRoot.querySelector('.specialist-progress');
        expect(progress.textContent).toContain('Iteration 2');
        expect(element.shadowRoot.querySelector('.specialist-list')).toBeNull();
        expect(buttonByTitle(element, 'Show specialist details').getAttribute('aria-expanded')).toBe('false');

        buttonByTitle(element, 'Show specialist details').click();
        await flushPromises();

        expect(element.shadowRoot.querySelector('.specialist-list').textContent).toContain('Object and Field Agent');
        expect(element.shadowRoot.querySelector('.specialist-list').textContent).toContain('Flow Agent');
        expect(element.shadowRoot.querySelector('.specialist-list').textContent).toContain('WAITING FOR DEPENDENCY');
        expect(buttonByTitle(element, 'Hide specialist details').getAttribute('aria-expanded')).toBe('true');
        expect(buttonByLabel(element, 'Approve Implementation')).not.toBeNull();
        expect([...element.shadowRoot.querySelectorAll('lightning-button')].filter((button) => button.label?.includes('Agent Approval'))).toHaveLength(0);
    });

    it('shows the current supervised action for plan review', async () => {
        const job = {
            jobId: 'job-current-action', status: 'AWAITING_PLAN_APPROVAL', approvals: [], logs: [],
            orgContext: { customerName: 'Customer', displayName: 'Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            plan: { planVersion: 1, notice: 'Review the plan.' },
            metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        expect(element.shadowRoot.querySelector('.current-action').textContent).toContain('Review the implementation plan');
        expect(element.shadowRoot.querySelector('.current-action').textContent).toContain('Implementation approval does not authorize deployment');
    });

    it('refreshes the workspace without triggering a job action', async () => {
        const job = {
            jobId: 'job-refresh', status: 'AWAITING_PLAN_APPROVAL', approvals: [], logs: [],
            orgContext: { customerName: 'Customer', displayName: 'Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            plan: { planVersion: 1 }, metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        buttonByTitle(element, 'Refresh workspace').click();
        await flushPromises();

        expect(getJobs).toHaveBeenCalledTimes(2);
        expect(getAgentJob).toHaveBeenCalledTimes(2);
        expect(performJobAction).not.toHaveBeenCalled();
    });

    it('shows the current planning activity instead of a misleading dependency status', async () => {
        const job = {
            jobId: 'job-planning', status: 'ANALYZING_DEPENDENCIES', currentActivity: 'Preparing implementation plan', logs: [],
            orgContext: { displayName: 'Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        expect(element.shadowRoot.querySelector('lightning-badge').label).toBe('Preparing implementation plan');
    });

    it('submits a drafted instruction when Request Changes is clicked', async () => {
        const job = {
            jobId: 'job-instruction', status: 'AWAITING_PLAN_APPROVAL', approvals: [], logs: [],
            orgContext: { displayName: 'Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            plan: { notice: 'Review the plan.' },
            metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));
        performJobAction.mockResolvedValue(JSON.stringify({ instructions: [{ instructionId: 'instruction-1', text: 'Please revise the plan.' }] }));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        const instructionField = textareaByLabel(element, 'Request a change or add an instruction');
        instructionField.value = 'Please revise the plan.';
        instructionField.dispatchEvent(new CustomEvent('change', { detail: { value: 'Please revise the plan.' }, bubbles: true }));
        buttonByLabel(element, 'Request Changes').click();
        await flushPromises();

        expect(performJobAction).toHaveBeenCalledWith(expect.objectContaining({
            jobId: 'job-instruction',
            action: 'instructions',
            payloadJson: JSON.stringify({ instruction: 'Please revise the plan.' })
        }));
    });

    it('explains a failed validation in human-readable language', async () => {
        const job = {
            jobId: 'job-failed', status: 'VALIDATION_FAILED', logs: [], approvals: [],
            orgContext: { displayName: 'SAPA Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            plan: { notice: 'No changes have been deployed.' },
            implementation: { commitHash: 'commit-1' },
            validation: { status: 'FAILED', failureReason: 'The Flow email recipient is configured in a format Salesforce does not accept.' },
            metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        const failure = element.shadowRoot.querySelector('.validation-failure');
        expect(failure.textContent).toContain('Why validation failed');
        expect(failure.textContent).toContain('Flow email recipient');
        expect(failure.textContent).toContain('Nothing was deployed');
        expect(element.shadowRoot.querySelector('.milestone--failed').textContent).toContain('Validation failed');
        expect(buttonByLabel(element, 'Approve Deployment')).toBeUndefined();
        expect(textareaByLabel(element, 'Request a change or add an instruction').disabled).toBe(false);
        expect(buttonByLabel(element, 'Send Instruction')).not.toBeUndefined();
    });

    it('keeps versioned implementation reports available and downloads the selected format', async () => {
        const job = {
            jobId: 'job-reports', status: 'AWAITING_PLAN_APPROVAL', logs: [], approvals: [], deployment: null,
            orgContext: { displayName: 'Developer Org', environment: 'developer', expectedOrgId: '00D000000000001', verified: {} },
            plan: { planVersion: 3, notice: 'A follow-up proposal is being reviewed.' },
            metadataScope: { primaryMetadata: [], dependencies: [] },
            implementationReports: [
                { reportId: 'implementation-report-v1', status: 'READY', deploymentVersion: 1, generatedAt: '2026-07-15T10:00:00Z' },
                { reportId: 'implementation-report-v2', status: 'READY', deploymentVersion: 2, generatedAt: '2026-07-16T10:00:00Z' }
            ]
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));
        getImplementationReport.mockResolvedValue(JSON.stringify({ fileName: 'Implementation-Report-TA-6-V1.pdf', contentType: 'application/pdf', contentBase64: 'JVBERg==' }));
        window.URL.createObjectURL = jest.fn(() => 'blob:implementation-report');
        window.URL.revokeObjectURL = jest.fn();
        const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        const reports = element.shadowRoot.querySelector('.implementation-reports');
        expect(reports.textContent).toContain('Implementation Report Ready');
        expect(reports.textContent).toContain('Deployment Version 1');
        expect(reports.textContent).toContain('Deployment Version 2');
        expect([...element.shadowRoot.querySelectorAll('lightning-button')].filter((button) => button.label?.startsWith('Download'))).toHaveLength(6);

        const firstPdf = [...element.shadowRoot.querySelectorAll('lightning-button')].find((button) => button.label === 'Download PDF' && button.dataset.version === '1');
        firstPdf.click();
        await flushPromises();

        expect(getImplementationReport).toHaveBeenCalledWith({ jobId: 'job-reports', deploymentVersion: 1, format: 'pdf' });
        expect(window.URL.createObjectURL).toHaveBeenCalled();
        expect(anchorClick).toHaveBeenCalled();
        anchorClick.mockRestore();
    });
});

function buttonByLabel(element, label) {
    return [...element.shadowRoot.querySelectorAll('lightning-button')].find((button) => button.label === label);
}

function textareaByLabel(element, label) {
    return [...element.shadowRoot.querySelectorAll('lightning-textarea')].find((textarea) => textarea.label === label);
}

function buttonByTitle(element, title) {
    return [...element.shadowRoot.querySelectorAll('lightning-button-icon')].find((button) => button.title === title);
}

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
