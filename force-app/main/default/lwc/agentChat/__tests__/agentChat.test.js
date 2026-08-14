import { createElement } from 'lwc';
import AgentChat from 'c/agentChat';
import createJob from '@salesforce/apex/AgentController.createJob';
import getJobs from '@salesforce/apex/AgentController.getJobs';
import getJob from '@salesforce/apex/AgentController.getJob';
import sendMessage from '@salesforce/apex/AgentController.sendMessage';
import performAction from '@salesforce/apex/AgentController.performAction';

jest.mock('@salesforce/apex/AgentController.createJob', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.getJobs', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.getJob', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.sendMessage', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AgentController.performAction', () => ({ default: jest.fn() }), { virtual: true });

const ORDINARY_JOB = {
    jobId: 'job-1',
    status: 'UNDERSTANDING',
    statusLabel: 'Understanding the request',
    updatedAt: '2026-08-14T12:00:00Z',
    canImplement: false,
    canDeploy: false,
    requirement: { summary: 'Add a donor automation' },
    orgContext: { displayName: 'Providus Sandbox', environment: 'sandbox', expectedOrgId: '00D000000000001' },
    conversation: [
        { conversationId: 'm-1', role: 'user', kind: 'requirement', text: 'Add a donor automation', timestamp: '2026-08-14T11:00:00Z' },
        { conversationId: 'm-2', role: 'assistant', kind: 'message', text: 'I am inspecting the org.', timestamp: '2026-08-14T11:01:00Z' }
    ]
};

describe('c-agent-chat persistent conversation workspace', () => {
    beforeEach(() => {
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [ORDINARY_JOB] }));
        getJob.mockResolvedValue(JSON.stringify(ORDINARY_JOB));
        createJob.mockResolvedValue(JSON.stringify({ jobId: 'job-created', status: 'RECEIVED' }));
        sendMessage.mockResolvedValue(JSON.stringify({ jobId: 'job-1', status: 'UNDERSTANDING' }));
        performAction.mockResolvedValue(JSON.stringify({ approval: { decision: 'APPROVED' } }));
    });

    afterEach(() => {
        while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    it('loads the persistent conversation list and selected timeline', async () => {
        const element = await createAgentChat();

        expect(getJobs).toHaveBeenCalledTimes(1);
        expect(getJob).toHaveBeenCalledWith({ jobId: 'job-1' });
        expect(element.shadowRoot.querySelector('.conversation-sidebar').textContent).toContain('Add a donor automation');
        expect(element.shadowRoot.querySelector('.chat-timeline').textContent).toContain('I am inspecting the org.');
        expect(element.shadowRoot.querySelector('[data-job-id="job-1"]').getAttribute('aria-current')).toBe('page');
    });

    it('selecting a conversation loads its persisted timeline', async () => {
        const second = job({ jobId: 'job-2', requirement: { summary: 'Second conversation' }, conversation: [{ conversationId: 'm-3', role: 'user', text: 'Second request', timestamp: '2026-08-14T12:01:00Z' }] });
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [ORDINARY_JOB, second] }));
        getJob.mockImplementation(({ jobId }) => Promise.resolve(JSON.stringify(jobId === 'job-2' ? second : ORDINARY_JOB)));
        const element = await createAgentChat();

        element.shadowRoot.querySelector('[data-job-id="job-2"]').click();
        await flushPromises();

        expect(getJob).toHaveBeenLastCalledWith({ jobId: 'job-2' });
        expect(element.shadowRoot.querySelector('.chat-timeline').textContent).toContain('Second request');
    });

    it('creating a conversation selects and reloads it without Jira', async () => {
        const created = job({ jobId: 'job-created', status: 'RECEIVED', requirement: { summary: 'New request' }, conversation: [] });
        getJob.mockImplementation(({ jobId }) => Promise.resolve(JSON.stringify(jobId === 'job-created' ? created : ORDINARY_JOB)));
        const element = await createAgentChat();
        change(textarea(element, 'Start a new conversation'), 'Build a safe inactive Flow');
        button(element, 'Create conversation').click();
        await flushPromises();
        await flushPromises();

        expect(createJob).toHaveBeenCalledWith({ prompt: 'Build a safe inactive Flow' });
        expect(getJob).toHaveBeenCalledWith({ jobId: 'job-created' });
        expect(element.shadowRoot.textContent).not.toContain('Jira');
    });

    it('ordinary user can converse but cannot see approval controls', async () => {
        const element = await createAgentChat();

        expect(element.shadowRoot.querySelector('[data-id="message-input"]')).not.toBeNull();
        expect(element.shadowRoot.querySelector('[data-id="approve-implementation"]')).toBeNull();
        expect(element.shadowRoot.querySelector('[data-id="approve-deployment"]')).toBeNull();
    });

    it('sends a follow-up once, clears the composer, and refreshes the selected job', async () => {
        const element = await createAgentChat();
        const input = textarea(element, 'Message Providus Nexus');
        change(input, 'Use the existing status field.');
        button(element, 'Send message').click();
        await flushPromises();
        await flushPromises();

        expect(sendMessage).toHaveBeenCalledWith({ jobId: 'job-1', text: 'Use the existing status field.' });
        expect(getJob).toHaveBeenCalledTimes(2);
        expect(input.value).toBe('');
    });

    it('disables blank sends and prevents duplicate sends in flight', async () => {
        let resolveSend;
        sendMessage.mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
        const element = await createAgentChat();
        expect(button(element, 'Send message').disabled).toBe(true);

        change(textarea(element, 'Message Providus Nexus'), 'One message');
        const send = button(element, 'Send message');
        send.click();
        send.click();
        await flushPromises();
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(button(element, 'Send message').disabled).toBe(true);

        resolveSend(JSON.stringify({ jobId: 'job-1' }));
        await flushPromises();
    });

    it('shows implementation approval only for an authorized user in the correct state', async () => {
        getJob.mockResolvedValue(JSON.stringify(job({ status: 'AWAITING_IMPLEMENTATION_APPROVAL', canImplement: true, canDeploy: true })));
        const element = await createAgentChat();
        expect(element.shadowRoot.querySelector('[data-id="approve-implementation"]')).not.toBeNull();
        expect(element.shadowRoot.querySelector('[data-id="approve-deployment"]')).toBeNull();

        element.shadowRoot.querySelector('[data-id="approve-implementation"]').click();
        await flushPromises();
        expect(performAction).toHaveBeenCalledWith({ jobId: 'job-1', action: 'APPROVE_IMPLEMENTATION', comments: '' });
    });

    it('shows deployment approval only for an authorized user in the correct state', async () => {
        getJob.mockResolvedValue(JSON.stringify(job({ status: 'AWAITING_DEPLOYMENT_APPROVAL', canImplement: true, canDeploy: true, validation: { validationId: 'validation-1', status: 'PASSED' } })));
        const element = await createAgentChat();
        expect(element.shadowRoot.querySelector('[data-id="approve-implementation"]')).toBeNull();
        expect(element.shadowRoot.querySelector('[data-id="approve-deployment"]')).not.toBeNull();
    });

    it('renders clarification, plan, progress, and completed result cards', async () => {
        getJob.mockResolvedValue(JSON.stringify(job({
            status: 'AWAITING_CLARIFICATION',
            statusLabel: 'Awaiting clarification',
            clarifications: [{ ambiguityId: 'a-1', status: 'OPEN', question: 'Which donation status counts as paid?' }],
            plan: { proposedImplementation: 'Create a number field and a record-triggered Flow.', approvedComponents: [{ metadataType: 'Flow', apiName: 'Donation_Installment' }] },
            implementationReport: { reportId: 'report-1', summary: 'Implementation is ready.', recordEffects: 'No records changed.' },
            conversation: []
        })));
        const element = await createAgentChat();
        expect(element.shadowRoot.querySelector('.clarification-card').textContent).toContain('Which donation status counts as paid?');
        expect(element.shadowRoot.querySelector('.plan-card').textContent).toContain('Create a number field');
        expect(element.shadowRoot.querySelector('.progress-card').textContent).toContain('Awaiting clarification');
        expect(element.shadowRoot.querySelector('.result-card').textContent).toContain('report-1');
    });

    it('completed inactive Flow deployment says deployed inactive and never activated', async () => {
        getJob.mockResolvedValue(JSON.stringify(job({
            status: 'COMPLETED',
            flowStatus: 'Draft',
            deployment: { status: 'SUCCEEDED', summary: 'Deployment succeeded.', components: [{ metadataType: 'Flow', apiName: 'Donation_Installment' }] },
            implementationReport: { reportId: 'report-draft', validationResult: 'Passed', deploymentResult: 'Succeeded' }
        })));
        const element = await createAgentChat();
        const result = element.shadowRoot.querySelector('.result-card').textContent.toLowerCase();
        expect(result).toContain('deployed inactive');
        expect(result).not.toContain('activated');
    });

    it('uses the persisted inactive deployment marker for completed Flow results', async () => {
        getJob.mockResolvedValue(JSON.stringify(job({
            status: 'COMPLETED',
            deployment: {
                status: 'SUCCEEDED', deploymentId: 'deployment-1', activated: false,
                components: [{ displayName: 'Flow', apiName: 'Donation_Installment' }]
            }
        })));
        const element = await createAgentChat();
        const result = element.shadowRoot.querySelector('.result-card').textContent.toLowerCase();
        expect(result).toContain('deployed inactive');
        expect(result).toContain('deployment-1');
    });

    it('summarizes persisted record effects and concurrency guidance', async () => {
        getJob.mockResolvedValue(JSON.stringify(job({
            status: 'COMPLETED',
            plan: { concurrencyConsiderations: 'Uses the retained component lease.' },
            deployment: { status: 'SUCCEEDED', recordResults: [{ operation: 'update' }, { operation: 'update' }] }
        })));
        const element = await createAgentChat();
        const result = element.shadowRoot.querySelector('.result-card').textContent;
        expect(result).toContain('2 approved record operations completed.');
        expect(result).toContain('Uses the retained component lease.');
    });

    it('shows sanitized useful errors and retains failed message input', async () => {
        sendMessage.mockRejectedValue({ body: { message: 'The message could not be accepted.' } });
        const element = await createAgentChat();
        change(textarea(element, 'Message Providus Nexus'), 'Please retry this');
        button(element, 'Send message').click();
        await flushPromises();

        expect(element.shadowRoot.querySelector('[role="alert"]').textContent).toContain('The message could not be accepted.');
        expect(textarea(element, 'Message Providus Nexus').value).toBe('Please retry this');
    });

    it('does not let a stale response replace a newly selected conversation', async () => {
        let resolveFirst;
        const second = job({ jobId: 'job-2', requirement: { summary: 'Second conversation' }, conversation: [{ conversationId: 'm-2', role: 'assistant', text: 'Current conversation', timestamp: '2026-08-14T12:00:00Z' }] });
        getJobs.mockResolvedValue(JSON.stringify({ jobs: [ORDINARY_JOB, second] }));
        getJob.mockImplementation(({ jobId }) => jobId === 'job-1'
            ? new Promise((resolve) => { resolveFirst = resolve; })
            : Promise.resolve(JSON.stringify(second)));
        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();
        element.shadowRoot.querySelector('[data-job-id="job-2"]').click();
        await flushPromises();
        resolveFirst(JSON.stringify(ORDINARY_JOB));
        await flushPromises();

        expect(element.shadowRoot.querySelector('.workspace-title').textContent).toContain('Second conversation');
        expect(element.shadowRoot.querySelector('.chat-timeline').textContent).toContain('Current conversation');
    });

    it('cleans the polling timer on disconnect and keeps accessible labels', async () => {
        const clearSpy = jest.spyOn(window, 'clearInterval');
        const element = createElement('c-agent-chat', { is: AgentChat });
        document.body.appendChild(element);
        await flushPromises();
        expect(textarea(element, 'Message Providus Nexus')).not.toBeNull();
        expect(button(element, 'Refresh conversation')).not.toBeUndefined();

        document.body.removeChild(element);
        expect(clearSpy).toHaveBeenCalled();
    });
});

function job(overrides = {}) {
    return {
        ...ORDINARY_JOB,
        conversation: [...ORDINARY_JOB.conversation],
        ...overrides
    };
}

async function createAgentChat() {
    const element = createElement('c-agent-chat', { is: AgentChat });
    document.body.appendChild(element);
    await flushPromises();
    await flushPromises();
    return element;
}

function button(element, label) {
    return [...element.shadowRoot.querySelectorAll('lightning-button')].find((item) => item.label === label);
}

function textarea(element, label) {
    return [...element.shadowRoot.querySelectorAll('lightning-textarea')].find((item) => item.label === label);
}

function change(input, value) {
    input.value = value;
    input.dispatchEvent(new CustomEvent('change', { detail: { value }, bubbles: true }));
}

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
