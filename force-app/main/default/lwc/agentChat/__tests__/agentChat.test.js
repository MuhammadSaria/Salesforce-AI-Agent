import { createElement } from 'lwc';
import AgentChat from 'c/agentChat';
import getJobs from '@salesforce/apex/AgentController.getJobs';
import getOrgs from '@salesforce/apex/AgentController.getOrgs';
import getAgentJob from '@salesforce/apex/AgentController.getAgentJob';

jest.mock('@salesforce/apex/AgentController.getJobs', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.getOrgs', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.getAgentJob', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.createAgentJob', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.performJobAction', () => ({ default: jest.fn() }), { virtual: true });

describe('c-agent-chat', () => {
    beforeEach(() => {
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [] }));
        getOrgs.mockResolvedValue(JSON.stringify({ orgs: [] }));
    });

    afterEach(() => {
        while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
        jest.clearAllMocks();
    });

    it('renders the supervised job entry controls', async () => {
        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();
        expect(element.shadowRoot.querySelector('lightning-input')).not.toBeNull();
        expect(element.shadowRoot.querySelector('lightning-textarea')).not.toBeNull();
        expect(buttonByLabel(element, 'Create Job')).not.toBeNull();
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

    it('hides the deployment action after the job completes', async () => {
        const job = {
            jobId: 'job-completed', status: 'COMPLETED', logs: [],
            orgContext: { displayName: 'Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            plan: { notice: 'Deployment completed.' },
            validation: { validationId: 'validation-1' },
            implementation: { commitHash: 'commit-1' },
            deployment: { deploymentId: '0Af000000000001' },
            approvals: [{ approvalType: 'DEPLOYMENT', validationId: 'validation-1', decision: 'APPROVED' }],
            metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        expect(buttonByLabel(element, 'Deploy Approved Package')).toBeUndefined();
        expect(element.shadowRoot.querySelector('.milestones').textContent).toContain('Deployment completed');
        expect(element.shadowRoot.querySelector('.milestones').textContent).toContain('0Af000000000001');
    });

    it('clearly reports completed implementation and validation milestones', async () => {
        const job = {
            jobId: 'job-validated', status: 'AWAITING_DEPLOYMENT_APPROVAL', logs: [],
            orgContext: { displayName: 'SAPA Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            plan: { notice: 'Separate deployment approval is required.' },
            implementation: { commitHash: 'commit-1' },
            validation: { validationId: 'validation-1', status: 'PASSED' },
            approvals: [], metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        const milestones = element.shadowRoot.querySelector('.milestones').textContent;
        expect(milestones).toContain('Local implementation completed');
        expect(milestones).toContain('Validation passed');
        expect(milestones).toContain('Deployment pending');
        expect(buttonByLabel(element, 'Approve Deployment')).not.toBeUndefined();
        const sectionLabels = [...element.shadowRoot.querySelectorAll('lightning-accordion-section')].map((section) => section.label);
        expect(sectionLabels).toEqual(['Jira Task Details and Requirement Analysis', 'Implementation Plan for Approval']);
    });

    it('replaces deployment approval with one execution action after approval', async () => {
        const job = {
            jobId: 'job-approved', status: 'AWAITING_DEPLOYMENT_APPROVAL', logs: [],
            orgContext: { displayName: 'SAPA Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001', verified: {} },
            plan: { notice: 'Separate deployment approval is required.' },
            implementation: { commitHash: 'commit-1' },
            validation: { validationId: 'validation-1', status: 'PASSED' },
            approvals: [{ approvalType: 'DEPLOYMENT', validationId: 'validation-1', decision: 'APPROVED' }],
            metadataScope: { primaryMetadata: [], dependencies: [] }
        };
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [job] }));
        getAgentJob.mockResolvedValue(JSON.stringify(job));

        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();

        expect(buttonByLabel(element, 'Approve Deployment')).toBeUndefined();
        expect(buttonByLabel(element, 'Deploy Approved Package')).not.toBeUndefined();
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
    });
});

function buttonByLabel(element, label) {
    return [...element.shadowRoot.querySelectorAll('lightning-button')].find((button) => button.label === label);
}

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
