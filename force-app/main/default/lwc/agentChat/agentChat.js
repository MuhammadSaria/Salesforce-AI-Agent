import { LightningElement } from 'lwc';
import createAgentJob from '@salesforce/apex/AgentController.createAgentJob';
import getJobs from '@salesforce/apex/AgentController.getJobs';
import getAgentJob from '@salesforce/apex/AgentController.getAgentJob';
import getOrgs from '@salesforce/apex/AgentController.getOrgs';
import performJobAction from '@salesforce/apex/AgentController.performJobAction';

const POLL_INTERVAL_MS = 3000;
const ACTIVE_STATES = new Set(['RECEIVED', 'VERIFYING_ORG', 'ANALYZING_JIRA', 'DISCOVERING_METADATA', 'RETRIEVING_RELEVANT_METADATA', 'ANALYZING_DEPENDENCIES', 'IMPLEMENTING', 'VALIDATING', 'DEPLOYING']);

export default class AgentChat extends LightningElement {
    prompt = '';
    jiraIssueKey = '';
    instruction = '';
    selectedOrgId = '';
    jobs = [];
    orgs = [];
    job;
    errorMessage = '';
    isBusy = false;
    pollTimer;

    connectedCallback() {
        this.loadConsole();
    }

    disconnectedCallback() {
        this.stopPolling();
    }

    get hasJob() { return Boolean(this.job); }
    get selectedJobId() { return this.job?.jobId || ''; }
    get plan() { return this.job?.plan; }
    get validation() { return this.job?.validation; }
    get orgContext() { return this.job?.orgContext; }
    get status() { return this.job?.status || 'NO_JOB_SELECTED'; }
    get isProduction() { return this.orgContext?.environment === 'production'; }
    get canSelectOrg() { return this.status === 'AWAITING_ORG_SELECTION'; }
    get canReviewPlan() { return this.status === 'AWAITING_PLAN_APPROVAL'; }
    get canImplement() { return this.status === 'VALIDATION_FAILED' && !this.job?.implementation; }
    get canValidate() { return this.status === 'VALIDATION_FAILED' && Boolean(this.job?.implementation); }
    get canApproveDeployment() { return this.status === 'AWAITING_DEPLOYMENT_APPROVAL'; }
    get hasDataOperations() { return Boolean(this.plan?.dataOperations?.length); }
    get hasDeleteOperations() { return Boolean(this.plan?.dataOperations?.some((operation) => operation.operation === 'delete')); }
    get approvalActionLabel() { return this.hasDeleteOperations ? 'Approve Record Deletion' : this.hasDataOperations ? 'Approve Data Execution' : 'Approve Deployment'; }
    get rejectionActionLabel() { return this.hasDeleteOperations ? 'Reject Record Deletion' : this.hasDataOperations ? 'Reject Data Execution' : 'Reject Deployment'; }
    get executionActionLabel() { return this.hasDeleteOperations ? 'Delete Approved Record' : this.hasDataOperations ? 'Execute Approved Data Changes' : 'Deploy Approved Package'; }
    get hasDeploymentApproval() {
        const latest = [...(this.job?.approvals || [])].reverse().find((item) => item.approvalType === 'DEPLOYMENT' && item.validationId === this.validation?.validationId);
        return latest?.decision === 'APPROVED';
    }
    get canRefreshAnalysis() { return ['RECEIVED', 'PLAN_REJECTED', 'ORG_VERIFICATION_FAILED'].includes(this.status); }
    get canCancel() { return !['COMPLETED', 'FAILED', 'CANCELLED', 'DEPLOYING'].includes(this.status); }
    get hasDiff() { return Boolean(this.job?.diff); }
    get jobOptions() { return this.jobs.map((item) => ({ label: `${item.jiraIssueKey || 'Manual'} - ${item.status}`, value: item.jobId })); }
    get orgOptions() {
        const candidates = this.job?.orgCandidates?.length ? this.job.orgCandidates : this.orgs;
        return candidates.map((item) => ({ label: `${item.displayName} (${item.environment})`, value: item.orgRegistryId }));
    }
    get metadataText() { return this.pretty(this.job?.metadataScope?.primaryMetadata || []); }
    get dependencyText() { return this.pretty(this.job?.metadataScope?.dependencies || []); }
    get planSummary() { return this.plan?.proposedImplementation || 'The implementation proposal is being prepared.'; }
    get implementationSteps() { return this.listItems(this.plan?.implementationSteps?.length ? this.plan.implementationSteps : [this.planSummary], 'step'); }
    get expectedOutcome() { return this.plan?.expectedOutcome || 'The requested Salesforce behavior will be available after validation and separate deployment approval.'; }
    get businessImpact() { return this.plan?.businessImpact || 'Only the approved requirement is intended to change.'; }
    get testingItems() { return this.listItems(this.plan?.testingStrategy || [], 'test'); }
    get riskAndAssumptionItems() { return this.listItems([...(this.plan?.risks || []), ...(this.plan?.assumptions || [])], 'risk'); }
    get outOfScopeItems() { return this.listItems(this.plan?.outOfScope?.length ? this.plan.outOfScope : ['Unrelated Salesforce behavior and data.'], 'scope'); }
    get rollbackPlan() { return this.plan?.rollbackPlan || 'Revert the approved change using the captured baseline.'; }
    get technicalPlanText() { return this.pretty({ filesToCreate: this.plan?.filesToCreate || [], filesToModify: this.plan?.filesToModify || [], dataOperations: this.plan?.dataOperations || [], metadataScopeHash: this.plan?.metadataScopeHash, planHash: this.plan?.planHash }); }
    get validationText() { return this.pretty(this.validation || {}); }
    get logsText() { return (this.job?.logs || []).map((item) => `${item.timestamp} [${item.level}] ${item.message}`).join('\n'); }
    get diffText() { return this.job?.diff || 'No local source differences recorded.'; }
    get createDisabled() { return this.isBusy || (!this.prompt.trim() && !this.jiraIssueKey.trim()); }

    async loadConsole() {
        this.isBusy = true;
        try {
            const [jobsResponse, orgsResponse] = await Promise.all([getJobs(), getOrgs()]);
            this.jobs = this.parse(jobsResponse).jobs || [];
            this.orgs = this.parse(orgsResponse).orgs || [];
            if (!this.job && this.jobs.length) await this.selectJob(this.jobs[0].jobId);
        } catch (error) {
            this.errorMessage = this.normalizeError(error);
        } finally {
            this.isBusy = false;
        }
    }

    handleValue(event) { this[event.target.dataset.field] = event.detail?.value ?? event.target.value; }
    async handleJobSelection(event) { await this.selectJob(event.detail.value); }

    async handleCreate() {
        await this.run(async () => {
            const response = this.parse(await createAgentJob({ prompt: this.prompt, jiraIssueKey: this.jiraIssueKey }));
            this.prompt = '';
            this.jiraIssueKey = '';
            await this.selectJob(response.jobId);
            await this.refreshJobs();
        });
    }

    async handleSelectOrg() {
        if (!this.selectedOrgId) return;
        await this.action('select-org', { orgRegistryId: this.selectedOrgId });
    }
    async handleAddInstruction() {
        if (!this.instruction.trim()) return;
        await this.action('instructions', { instruction: this.instruction });
        this.instruction = '';
    }
    async handleRefreshAnalysis() { await this.action('analyze', {}); }
    async handleApproveImplementation() { await this.action('approve-implementation', { planVersion: this.plan.planVersion, comments: 'Approved in Salesforce agent console.' }); }
    async handleRejectPlan() { await this.action('reject-plan', { comments: 'Rejected in Salesforce agent console.' }); }
    async handleImplement() { await this.action('implement', {}); }
    async handleValidate() { await this.action('validate', {}); }
    async handleApproveDeployment() { await this.action('approve-deployment', { validationId: this.validation.validationId, productionSpecificApproval: this.isProduction, comments: this.hasDataOperations ? 'Salesforce data execution explicitly approved in the agent console.' : (this.isProduction ? 'Production deployment explicitly approved in Salesforce agent console.' : 'Deployment approved in Salesforce agent console.') }); }
    async handleRejectDeployment() { await this.action('reject-deployment', { comments: 'Deployment rejected in Salesforce agent console.' }); }
    async handleDeploy() { await this.action('deploy', {}); }
    async handleCancel() { await this.action('cancel', { reason: 'Cancelled in Salesforce agent console.' }); }

    async action(action, payload) {
        await this.run(async () => {
            await performJobAction({ jobId: this.job.jobId, action, payloadJson: JSON.stringify(payload) });
            await this.refreshJob();
            if (ACTIVE_STATES.has(this.status) || ['IMPLEMENTING', 'AWAITING_DEPLOYMENT_APPROVAL'].includes(this.status)) this.startPolling();
        });
    }

    async selectJob(jobId) {
        this.stopPolling();
        this.job = this.normalizeJob(this.parse(await getAgentJob({ jobId })));
        this.selectedOrgId = this.orgContext?.orgRegistryId || '';
        if (ACTIVE_STATES.has(this.status)) this.startPolling();
    }

    async refreshJob() {
        if (!this.job?.jobId) return;
        this.job = this.normalizeJob(this.parse(await getAgentJob({ jobId: this.job.jobId })));
        if (!ACTIVE_STATES.has(this.status)) this.stopPolling();
    }

    async refreshJobs() { this.jobs = this.parse(await getJobs()).jobs || []; }
    startPolling() { this.stopPolling(); this.pollTimer = window.setInterval(() => this.refreshJob().catch((error) => { this.errorMessage = this.normalizeError(error); this.stopPolling(); }), POLL_INTERVAL_MS); }
    stopPolling() { if (this.pollTimer) window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
    async run(callback) { this.isBusy = true; this.errorMessage = ''; try { await callback(); } catch (error) { this.errorMessage = this.normalizeError(error); } finally { this.isBusy = false; } }
    parse(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
    normalizeJob(job) {
        return {
            ...job,
            approvals: job?.approvals || [],
            logs: job?.logs || [],
            orgCandidates: job?.orgCandidates || [],
            requirement: job?.requirement || { summary: '', acceptanceCriteria: '' },
            orgContext: job?.orgContext || { customerName: '', displayName: '', environment: '', expectedOrgId: '', verified: { verifiedAt: '' } },
            metadataScope: job?.metadataScope || { primaryMetadata: [], dependencies: [] }
        };
    }
    pretty(value) { return JSON.stringify(value, null, 2); }
    listItems(values, prefix) { return values.map((text, index) => ({ key: `${prefix}-${index}`, text })); }
    normalizeError(error) { return error?.body?.message || error?.message || 'Unexpected error.'; }
}
