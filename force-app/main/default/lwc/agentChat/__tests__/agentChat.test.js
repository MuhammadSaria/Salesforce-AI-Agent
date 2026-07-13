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
});

function buttonByLabel(element, label) {
    return [...element.shadowRoot.querySelectorAll('lightning-button')].find((button) => button.label === label);
}

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
