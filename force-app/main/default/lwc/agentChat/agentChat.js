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
    get canApproveDeployment() { return this.status === 'AWAITING_DEPLOYMENT_APPROVAL' && !this.hasDeploymentApproval; }
    get hasDataOperations() { return Boolean(this.plan?.dataOperations?.length); }
    get hasDeleteOperations() { return Boolean(this.plan?.dataOperations?.some((operation) => operation.operation === 'delete')); }
    get approvalActionLabel() { return this.hasDeleteOperations ? 'Approve Record Deletion' : this.hasDataOperations ? 'Approve Data Execution' : 'Approve Deployment'; }
    get rejectionActionLabel() { return this.hasDeleteOperations ? 'Reject Record Deletion' : this.hasDataOperations ? 'Reject Data Execution' : 'Reject Deployment'; }
    get executionActionLabel() { return this.hasDeleteOperations ? 'Delete Approved Record' : this.hasDataOperations ? 'Execute Approved Data Changes' : 'Deploy Approved Package'; }
    get hasDeploymentApproval() {
        if (this.status !== 'AWAITING_DEPLOYMENT_APPROVAL') return false;
        const latest = [...(this.job?.approvals || [])].reverse().find((item) => item.approvalType === 'DEPLOYMENT' && item.validationId === this.validation?.validationId);
        return latest?.decision === 'APPROVED';
    }
    get canRefreshAnalysis() { return ['RECEIVED', 'PLAN_REJECTED', 'ORG_VERIFICATION_FAILED'].includes(this.status); }
    get canCancel() { return !['COMPLETED', 'FAILED', 'CANCELLED', 'DEPLOYING'].includes(this.status); }
    get canAddInstruction() { return !['IMPLEMENTING', 'VALIDATING', 'DEPLOYING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(this.status); }
    get instructionInputDisabled() { return this.isBusy || !this.canAddInstruction; }
    get instructionSendDisabled() { return this.instructionInputDisabled || !this.instruction.trim(); }
    get jobOptions() { return this.jobs.map((item) => ({ label: `${item.jiraIssueKey || 'Manual'} - ${item.status}`, value: item.jobId })); }
    get orgOptions() {
        const candidates = this.job?.orgCandidates?.length ? this.job.orgCandidates : this.orgs;
        return candidates.map((item) => ({ label: `${item.displayName} (${item.environment})`, value: item.orgRegistryId }));
    }
    get planSummary() { return this.plan?.proposedImplementation || 'The implementation proposal is being prepared.'; }
    get implementationSteps() { return this.listItems(this.plan?.implementationSteps?.length ? this.plan.implementationSteps : [this.planSummary], 'step'); }
    get expectedOutcome() { return this.plan?.expectedOutcome || 'The requested Salesforce behavior will be available after validation and separate deployment approval.'; }
    get businessImpact() { return this.plan?.businessImpact || 'Only the approved requirement is intended to change.'; }
    get testingItems() { return this.listItems(this.plan?.testingStrategy || [], 'test'); }
    get riskAndAssumptionItems() { return this.listItems([...(this.plan?.risks || []), ...(this.plan?.assumptions || [])], 'risk'); }
    get outOfScopeItems() { return this.listItems(this.plan?.outOfScope?.length ? this.plan.outOfScope : ['Unrelated Salesforce behavior and data.'], 'scope'); }
    get rollbackPlan() { return this.plan?.rollbackPlan || 'Revert the approved change using the captured baseline.'; }
    get planNotice() {
        if (this.deploymentComplete) return `Deployment completed successfully in ${this.orgContext.displayName}.`;
        if (this.validationFailed) return 'Validation failed. Nothing was deployed, and deployment remains blocked until the implementation is corrected and validated again.';
        if (this.validationComplete) return 'Validation passed. No deployment will occur until separate deployment approval is granted.';
        if (this.implementationComplete) return 'Local implementation completed. No Salesforce changes have been deployed yet.';
        return this.plan?.notice || 'No changes have been made yet.';
    }
    get implementationComplete() { return Boolean(this.job?.implementation); }
    get validationComplete() { return this.validation?.status === 'PASSED'; }
    get validationFailed() { return this.status === 'VALIDATION_FAILED' || this.validation?.status === 'FAILED'; }
    get validationFailureReason() { return this.validation?.failureReason || 'Salesforce did not accept the proposed change. Review the implementation and run validation again.'; }
    get deploymentComplete() { return this.status === 'COMPLETED' && Boolean(this.job?.deployment); }
    get implementationMilestoneClass() { return this.milestoneClass(this.implementationComplete, this.status === 'IMPLEMENTING'); }
    get validationMilestoneClass() { return this.validationFailed ? 'milestone milestone--failed' : this.milestoneClass(this.validationComplete, this.status === 'VALIDATING'); }
    get deploymentMilestoneClass() { return this.milestoneClass(this.deploymentComplete, this.status === 'DEPLOYING'); }
    get implementationMilestoneIcon() { return this.milestoneIcon(this.implementationComplete, this.status === 'IMPLEMENTING'); }
    get validationMilestoneIcon() { return this.validationFailed ? 'utility:error' : this.milestoneIcon(this.validationComplete, this.status === 'VALIDATING'); }
    get deploymentMilestoneIcon() { return this.milestoneIcon(this.deploymentComplete, this.status === 'DEPLOYING'); }
    get implementationMilestoneTitle() { return this.implementationComplete ? 'Local implementation completed' : this.status === 'IMPLEMENTING' ? 'Implementation in progress' : 'Implementation pending'; }
    get validationMilestoneTitle() { return this.validationFailed ? 'Validation failed' : this.validationComplete ? 'Validation passed' : this.status === 'VALIDATING' ? 'Validation in progress' : 'Validation pending'; }
    get deploymentMilestoneTitle() { return this.deploymentComplete ? 'Deployment completed' : this.status === 'DEPLOYING' ? 'Deployment in progress' : 'Deployment pending'; }
    get implementationMilestoneMessage() { return this.implementationComplete ? 'The approved changes were created locally and committed.' : 'Waiting for implementation approval and local execution.'; }
    get validationMilestoneMessage() { return this.validationFailed ? 'Salesforce rejected part of the proposed implementation.' : this.validationComplete ? `Salesforce validation passed for ${this.orgContext.displayName}.` : 'Validation starts after the local implementation is complete.'; }
    get deploymentMilestoneMessage() { return this.deploymentComplete ? `Successfully deployed to ${this.orgContext.displayName}. Deployment ID: ${this.job.deployment.deploymentId || 'not returned'}.` : this.validationFailed ? 'Deployment is blocked until validation passes.' : 'A separate deployment approval is required after validation.'; }
    get conversationItems() {
        const messages = (this.job?.instructions || []).map((item, index) => ({
            key: item.instructionId || `instruction-${index}`,
            author: 'You',
            meta: item.timestamp || '',
            text: item.text,
            className: 'message message--user'
        }));
        messages.push({ key: `agent-${this.status}-${this.plan?.planVersion || 0}`, author: 'Agent', meta: this.status, text: this.agentConversationMessage, className: 'message message--agent' });
        return messages;
    }
    get agentConversationMessage() {
        if (this.status === 'AWAITING_PLAN_APPROVAL') return `I prepared plan version ${this.plan?.planVersion || 1}. Review it, request another change, or approve its local implementation.`;
        if (this.status === 'VALIDATION_FAILED') return `${this.validationFailureReason} Send a change request and I will prepare a revised plan, or revalidate after correcting the approved implementation.`;
        if (this.status === 'AWAITING_DEPLOYMENT_APPROVAL') return 'Validation passed. You can approve deployment or send another change request; a change request will invalidate the current implementation and validation approvals.';
        if (this.status === 'IMPLEMENTING') return 'I am implementing the approved plan locally. Change requests will be available when this operation finishes.';
        if (this.status === 'VALIDATING') return 'I am validating the local implementation against the verified Salesforce org.';
        if (this.status === 'DEPLOYING') return 'The separately approved package is being deployed. It is too late to revise this deployment job.';
        if (this.status === 'COMPLETED') return 'The approved change was deployed and this job is complete. Create a new job for additional work.';
        if (this.status === 'AWAITING_ORG_SELECTION') return 'Select the target Salesforce org before I analyze the requirement.';
        if (['RECEIVED', 'VERIFYING_ORG', 'ANALYZING_JIRA', 'DISCOVERING_METADATA', 'RETRIEVING_RELEVANT_METADATA', 'ANALYZING_DEPENDENCIES'].includes(this.status)) return `I received the request and am preparing plan version ${this.job?.nextPlanVersion || 1}.`;
        return 'Review the current job status and provide an instruction when change requests are available.';
    }
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
        if (!this.canAddInstruction || !this.instruction.trim()) return;
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
    listItems(values, prefix) { return values.map((text, index) => ({ key: `${prefix}-${index}`, text })); }
    milestoneClass(complete, active) { return `milestone${complete ? ' milestone--complete' : active ? ' milestone--active' : ''}`; }
    milestoneIcon(complete, active) { return complete ? 'utility:success' : active ? 'utility:sync' : 'utility:clock'; }
    normalizeError(error) { return error?.body?.message || error?.message || 'Unexpected error.'; }
}
