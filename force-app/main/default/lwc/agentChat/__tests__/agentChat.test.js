import { createElement } from 'lwc';
import AgentChat from 'c/agentChat';
import getJobs from '@salesforce/apex/AgentController.getJobs';
import getOrgs from '@salesforce/apex/AgentController.getOrgs';
import getAgentJob from '@salesforce/apex/AgentController.getAgentJob';
import createAgentJob from '@salesforce/apex/AgentController.createAgentJob';
import performJobAction from '@salesforce/apex/AgentController.performJobAction';

jest.mock('@salesforce/apex/AgentController.getJobs', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.getOrgs', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.getAgentJob', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.createAgentJob', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.performJobAction', () => ({ default: jest.fn() }), { virtual: true });

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
});

function buttonByLabel(element, label) {
    return [...element.shadowRoot.querySelectorAll('lightning-button')].find((button) => button.label === label);
}

function textareaByLabel(element, label) {
    return [...element.shadowRoot.querySelectorAll('lightning-textarea')].find((textarea) => textarea.label === label);
}

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
