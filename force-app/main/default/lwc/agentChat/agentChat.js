import { LightningElement } from 'lwc';
import createJob from '@salesforce/apex/AgentController.createJob';
import getJobs from '@salesforce/apex/AgentController.getJobs';
import getJob from '@salesforce/apex/AgentController.getJob';
import sendMessage from '@salesforce/apex/AgentController.sendMessage';
import performAction from '@salesforce/apex/AgentController.performAction';

const POLL_INTERVAL_MS = 3000;
const PROCESSING_STATES = new Set([
    'RECEIVED', 'UNDERSTANDING', 'INSPECTING_ORG', 'PLANNING', 'IMPLEMENTING',
    'WAITING_FOR_LOCK', 'VALIDATING', 'CORRECTING', 'DEPLOYING'
]);
const CLOSED_STATES = new Set(['COMPLETED', 'CANCELLED']);
const STATUS_LABELS = {
    RECEIVED: 'Understanding request',
    UNDERSTANDING: 'Understanding request',
    AWAITING_CLARIFICATION: 'Awaiting clarification',
    INSPECTING_ORG: 'Inspecting the Salesforce org',
    PLANNING: 'Planning',
    AWAITING_IMPLEMENTATION_APPROVAL: 'Awaiting implementation approval',
    AWAITING_PLAN_APPROVAL: 'Awaiting implementation approval',
    IMPLEMENTING: 'Implementing',
    WAITING_FOR_LOCK: 'Waiting for component access',
    VALIDATING: 'Validating',
    CORRECTING: 'Correcting validation findings',
    AWAITING_DEPLOYMENT_APPROVAL: 'Awaiting deployment approval',
    DEPLOYING: 'Deploying',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled'
};

export default class AgentChat extends LightningElement {
    jobs = [];
    selectedJob;
    messages = [];
    draftMessage = '';
    newPrompt = '';
    actionComments = '';
    isSending = false;
    isLoading = false;
    isSelecting = false;
    isActing = false;
    isRefreshing = false;
    canImplement = false;
    canDeploy = false;
    errorMessage = '';
    requestedJobId = '';
    pollTimer;
    requestSequence = 0;

    connectedCallback() {
        this.loadWorkspace();
    }

    disconnectedCallback() {
        this.stopPolling();
        this.requestSequence += 1;
    }

    get hasSelectedJob() { return Boolean(this.selectedJob); }
    get selectedJobId() { return this.selectedJob?.jobId || this.requestedJobId || ''; }
    get status() { return this.selectedJob?.status || ''; }
    get statusLabel() { return this.selectedJob?.statusLabel || STATUS_LABELS[this.status] || 'Status unavailable'; }
    get workspaceTitle() { return this.titleFor(this.selectedJob); }
    get orgContext() { return this.selectedJob?.orgContext || {}; }
    get environmentName() { return this.orgContext.environment || 'sandbox'; }
    get environmentLabel() { return `${this.orgContext.displayName || 'Salesforce org'} · ${this.environmentName}`; }
    get isProduction() { return String(this.environmentName).toLowerCase() === 'production'; }
    get isBusy() { return this.isLoading || this.isSelecting || this.isSending || this.isActing || this.isRefreshing; }
    get createDisabled() { return this.isBusy || !this.newPrompt.trim(); }
    get messageDisabled() { return this.isSending || this.isActing || !this.hasSelectedJob || CLOSED_STATES.has(this.status); }
    get sendDisabled() { return this.messageDisabled || !this.draftMessage.trim(); }
    get canApproveImplementation() {
        return this.canImplement && ['AWAITING_IMPLEMENTATION_APPROVAL', 'AWAITING_PLAN_APPROVAL'].includes(this.status);
    }
    get canApproveDeployment() {
        return this.canDeploy && this.status === 'AWAITING_DEPLOYMENT_APPROVAL' && !this.hasDeploymentApproval;
    }
    get canDeployApprovedChange() {
        return this.canDeploy && this.status === 'AWAITING_DEPLOYMENT_APPROVAL' && this.hasDeploymentApproval;
    }
    get hasDeploymentApproval() {
        const validationId = this.selectedJob?.validation?.validationId;
        const approval = [...(this.selectedJob?.approvals || [])].reverse().find((item) =>
            item.approvalType === 'DEPLOYMENT' && (!validationId || item.validationId === validationId)
        );
        return approval?.decision === 'APPROVED';
    }
    get showActionPanel() { return this.canApproveImplementation || this.canApproveDeployment || this.canDeployApprovedChange; }
    get openClarification() {
        return (this.selectedJob?.clarifications || []).find((item) => item.status === 'OPEN');
    }
    get hasClarification() { return Boolean(this.openClarification); }
    get clarificationQuestion() { return this.openClarification?.question || this.openClarification?.materialQuestion || ''; }
    get hasPlan() { return Boolean(this.selectedJob?.plan); }
    get planSummary() {
        const plan = this.selectedJob?.plan || {};
        return plan.proposedImplementation || plan.summary || plan.safeBehaviorDescription || 'The implementation plan is ready for review.';
    }
    get planComponents() {
        const plan = this.selectedJob?.plan || {};
        const components = plan.approvedComponents || plan.components || this.selectedJob?.metadataScope?.primaryMetadata || [];
        return components.map((item, index) => ({
            key: `component-${index}`,
            label: typeof item === 'string' ? item : [item.metadataType || item.type, item.apiName || item.fullName].filter(Boolean).join(': ') || 'Approved component',
            description: typeof item === 'string' ? '' : item.safeBehaviorDescription || item.description || ''
        }));
    }
    get hasPlanComponents() { return this.planComponents.length > 0; }
    get showResult() {
        return Boolean(this.selectedJob?.implementationReport || this.selectedJob?.report || this.selectedJob?.deployment || this.status === 'COMPLETED');
    }
    get report() { return this.selectedJob?.implementationReport || this.selectedJob?.report || {}; }
    get reportId() { return this.report.reportId || this.report.identifier || this.selectedJob?.deployment?.deploymentId || ''; }
    get reportSummary() { return this.report.summary || this.selectedJob?.deployment?.summary || 'The requested work completed.'; }
    get validationResult() { return this.report.validationResult || this.selectedJob?.validation?.status || ''; }
    get deploymentResult() { return this.report.deploymentResult || this.selectedJob?.deployment?.status || ''; }
    get recordEffects() {
        const explicit = this.report.recordEffects || this.selectedJob?.deployment?.recordEffects;
        if (explicit) return explicit;
        const count = this.selectedJob?.deployment?.recordResults?.length || 0;
        return count ? `${count} approved record operation${count === 1 ? '' : 's'} completed.` : '';
    }
    get concurrencyConsiderations() { return this.report.concurrencyConsiderations || this.selectedJob?.plan?.concurrencyConsiderations || ''; }
    get implementedComponents() {
        const components = this.report.implementedComponents || this.selectedJob?.deployment?.components || [];
        return components.map((item, index) => ({
            key: `result-component-${index}`,
            label: typeof item === 'string' ? item : [item.metadataType || item.displayName || item.type, item.apiName || item.fullName].filter(Boolean).join(': ') || 'Implemented component'
        }));
    }
    get hasImplementedComponents() { return this.implementedComponents.length > 0; }
    get isInactiveFlowDeployment() {
        if (this.status !== 'COMPLETED') return false;
        const statuses = [
            this.selectedJob?.flowStatus,
            this.report.flowStatus,
            this.selectedJob?.deployment?.flowStatus,
            ...(this.selectedJob?.deployment?.components || []).map((item) => item.flowStatus || item.status)
        ];
        if (statuses.some((value) => String(value || '').toLowerCase() === 'draft')) return true;
        const flowPlanned = [
            ...(this.selectedJob?.deployment?.components || []),
            ...(this.selectedJob?.plan?.approvedComponents || []),
            ...(this.selectedJob?.plan?.components || [])
        ].some((item) => String(typeof item === 'string' ? item : item.metadataType || item.displayName || item.type || '').toLowerCase().includes('flow'));
        return this.selectedJob?.deployment?.activated === false && flowPlanned;
    }
    get jobItems() {
        return this.jobs.map((item) => ({
            ...item,
            title: this.titleFor(item),
            statusText: item.statusLabel || STATUS_LABELS[item.status] || item.status || 'Status unavailable',
            updatedText: item.updatedAt || item.createdAt || '',
            ariaCurrent: item.jobId === this.selectedJobId ? 'page' : 'false',
            buttonClass: `conversation-item${item.jobId === this.selectedJobId ? ' conversation-item--selected' : ''}`
        }));
    }

    async loadWorkspace() {
        this.isLoading = true;
        this.errorMessage = '';
        try {
            await this.refreshJobs();
            if (this.jobs.length) await this.selectJob(this.jobs[0].jobId);
        } catch (error) {
            this.errorMessage = this.normalizeError(error);
        } finally {
            this.isLoading = false;
        }
    }

    async refreshJobs() {
        const response = this.parse(await getJobs());
        this.jobs = (response.jobs || []).map((item) => this.normalizeJob(item, response));
    }

    async selectJob(jobId) {
        if (!jobId) return;
        this.stopPolling();
        const requestId = ++this.requestSequence;
        this.requestedJobId = jobId;
        this.isSelecting = true;
        this.errorMessage = '';
        try {
            const response = this.parse(await getJob({ jobId }));
            if (requestId !== this.requestSequence || this.requestedJobId !== jobId) return;
            const value = response.job || response;
            this.applySelectedJob(this.normalizeJob(value, response));
        } catch (error) {
            if (requestId === this.requestSequence) this.errorMessage = this.normalizeError(error);
        } finally {
            if (requestId === this.requestSequence) this.isSelecting = false;
        }
    }

    async refreshSelectedJob(expectedJobId = this.selectedJobId) {
        if (!expectedJobId || expectedJobId !== this.selectedJobId) return;
        await this.selectJob(expectedJobId);
        await this.refreshJobs();
    }

    applySelectedJob(job) {
        this.selectedJob = job;
        this.requestedJobId = job.jobId;
        this.canImplement = job.canImplement === true;
        this.canDeploy = job.canDeploy === true;
        this.messages = [...(job.conversation || [])]
            .sort((left, right) => String(left.timestamp || '').localeCompare(String(right.timestamp || '')))
            .map((entry, index) => this.presentMessage(entry, index));
        if (PROCESSING_STATES.has(job.status)) this.startPolling();
        else this.stopPolling();
    }

    presentMessage(entry, index) {
        const role = String(entry.role || 'system').toLowerCase();
        const kind = String(entry.kind || 'message').toLowerCase();
        const isUser = role === 'user';
        const isClarification = kind.includes('clarification');
        const isEvent = ['status', 'event', 'system'].includes(kind) || role === 'system';
        return {
            ...entry,
            key: entry.conversationId || `message-${index}`,
            authorLabel: isUser ? 'You' : isEvent ? 'Status' : isClarification ? 'Clarification' : 'Providus Nexus',
            messageClass: `message message--${isUser ? 'user' : isEvent ? 'event' : isClarification ? 'clarification' : 'agent'}`
        };
    }

    handleValue(event) {
        const field = event.target.dataset.field;
        const value = event.detail?.value ?? event.target.value ?? '';
        this[field] = field === 'actionComments' ? value.slice(0, 1000) : value;
    }

    handleJobSelection(event) {
        this.selectJob(event.currentTarget.dataset.jobId);
    }

    async handleCreate() {
        if (this.createDisabled) return;
        const prompt = this.newPrompt.trim();
        this.isActing = true;
        this.errorMessage = '';
        try {
            const created = this.parse(await createJob({ prompt }));
            this.newPrompt = '';
            await this.refreshJobs();
            await this.selectJob(created.jobId);
        } catch (error) {
            this.errorMessage = this.normalizeError(error);
        } finally {
            this.isActing = false;
        }
    }

    async handleSend() {
        if (this.sendDisabled) return;
        const jobId = this.selectedJobId;
        const text = this.draftMessage.trim();
        this.isSending = true;
        this.errorMessage = '';
        try {
            await sendMessage({ jobId, text });
            if (jobId === this.selectedJobId) this.draftMessage = '';
            await this.refreshSelectedJob(jobId);
        } catch (error) {
            this.errorMessage = this.normalizeError(error);
        } finally {
            this.isSending = false;
        }
    }

    handleComposerKeydown(event) {
        if (event.key === 'Enter' && !event.shiftKey && !this.sendDisabled) {
            event.preventDefault();
            this.handleSend();
        }
    }

    async handleRefresh() {
        if (!this.selectedJobId || this.isRefreshing) return;
        this.isRefreshing = true;
        this.errorMessage = '';
        try { await this.refreshSelectedJob(); }
        catch (error) { this.errorMessage = this.normalizeError(error); }
        finally { this.isRefreshing = false; }
    }

    handleApproveImplementation() { this.runAction('APPROVE_IMPLEMENTATION'); }
    handleRejectImplementation() { this.runAction('REJECT_IMPLEMENTATION'); }
    handleApproveDeployment() { this.runAction('APPROVE_DEPLOYMENT'); }
    handleRejectDeployment() { this.runAction('REJECT_DEPLOYMENT'); }
    handleDeploy() { this.runAction('DEPLOY'); }

    async runAction(action) {
        if (this.isActing || !this.selectedJobId) return;
        const jobId = this.selectedJobId;
        this.isActing = true;
        this.errorMessage = '';
        try {
            await performAction({ jobId, action, comments: this.actionComments.trim() });
            if (jobId === this.selectedJobId) this.actionComments = '';
            await this.refreshSelectedJob(jobId);
        } catch (error) {
            this.errorMessage = this.normalizeError(error);
        } finally {
            this.isActing = false;
        }
    }

    startPolling() {
        this.stopPolling();
        this.pollTimer = window.setInterval(async () => {
            const jobId = this.selectedJobId;
            try { await this.refreshSelectedJob(jobId); }
            catch (error) { this.errorMessage = this.normalizeError(error); this.stopPolling(); }
        }, POLL_INTERVAL_MS);
    }

    stopPolling() {
        if (this.pollTimer) window.clearInterval(this.pollTimer);
        this.pollTimer = undefined;
    }

    normalizeJob(value, envelope = {}) {
        const job = value || {};
        return {
            ...job,
            canImplement: job.canImplement === true || envelope.canImplement === true,
            canDeploy: job.canDeploy === true || envelope.canDeploy === true,
            conversation: job.conversation || [],
            approvals: job.approvals || [],
            clarifications: job.clarifications || [],
            orgContext: job.orgContext || {},
            requirement: job.requirement || {},
            metadataScope: job.metadataScope || {}
        };
    }

    titleFor(job) {
        const firstUserMessage = (job?.conversation || []).find((entry) => entry.role === 'user');
        return job?.title || job?.requirement?.summary || job?.plan?.requirement || firstUserMessage?.text || `Conversation ${job?.jobId || ''}`;
    }

    parse(value) { return typeof value === 'string' ? JSON.parse(value) : (value || {}); }

    normalizeError(error) {
        const message = String(error?.body?.message || error?.message || 'The request could not be completed.').replace(/[\r\n]+/g, ' ').slice(0, 300);
        const lowered = message.toLowerCase();
        if (['authorization', 'bearer', 'token', 'credential', 'stack trace', 'postgres', 'database'].some((term) => lowered.includes(term))) {
            return 'The request could not be completed safely.';
        }
        return message;
    }
}
