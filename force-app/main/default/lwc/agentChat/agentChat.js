import { LightningElement } from 'lwc';
import createAgentJob from '@salesforce/apex/AgentController.createAgentJob';
import getJobs from '@salesforce/apex/AgentController.getJobs';
import getAgentJob from '@salesforce/apex/AgentController.getAgentJob';
import getOrgs from '@salesforce/apex/AgentController.getOrgs';
import performJobAction from '@salesforce/apex/AgentController.performJobAction';
import getImplementationReport from '@salesforce/apex/AgentController.getImplementationReport';

const POLL_INTERVAL_MS = 3000;
const ACTIVE_STATES = new Set(['RECEIVED', 'VERIFYING_ORG', 'ANALYZING_JIRA', 'DISCOVERING_METADATA', 'RETRIEVING_RELEVANT_METADATA', 'ANALYZING_DEPENDENCIES', 'IMPLEMENTING', 'VALIDATING', 'DEPLOYING']);
const WORKFLOW_STAGES = [
    { key: 'analysis', label: 'Analysis' },
    { key: 'plan', label: 'Plan' },
    { key: 'implementation', label: 'Implementation' },
    { key: 'validation', label: 'Validation' },
    { key: 'deployment', label: 'Deployment' }
];

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
    specialistsExpanded = false;
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
    get verifiedAt() { return this.orgContext?.verified?.verifiedAt || ''; }
    get status() { return this.job?.status || 'NO_JOB_SELECTED'; }
    get statusDisplay() {
        if (this.status === 'ANALYZING_DEPENDENCIES' && this.job?.currentActivity) return this.job.currentActivity;
        return this.status.replaceAll('_', ' ');
    }
    get currentAction() {
        const actions = {
            AWAITING_ORG_SELECTION: {
                title: 'Select the target Salesforce org',
                message: 'Choose one verified org before analysis can continue.',
                iconName: 'utility:company',
                tone: 'attention'
            },
            AWAITING_PLAN_APPROVAL: {
                title: 'Review the implementation plan',
                message: 'Review the scope, tests, and rollback plan. Implementation approval does not authorize deployment.',
                iconName: 'utility:approval',
                tone: 'attention'
            },
            IMPLEMENTING: {
                title: 'Applying the approved changes locally',
                message: 'Providus Nexus is updating only the approved files. Nothing is being deployed yet.',
                iconName: 'utility:settings',
                tone: 'active'
            },
            VALIDATING: {
                title: 'Validating the implementation',
                message: 'Salesforce validation and relevant tests are running against the verified target org.',
                iconName: 'utility:test',
                tone: 'active'
            },
            VALIDATION_FAILED: {
                title: 'Validation needs attention',
                message: this.validationFailureReason,
                iconName: 'utility:error',
                tone: 'error'
            },
            AWAITING_DEPLOYMENT_APPROVAL: {
                title: this.hasDeploymentApproval ? 'Approved deployment is ready' : 'Review validation and approve deployment',
                message: this.hasDeploymentApproval
                    ? 'The validated package can now be deployed to the exact approved org.'
                    : 'Implementation approval does not authorize deployment. Review the validation result before deciding.',
                iconName: 'utility:upload',
                tone: 'attention'
            },
            DEPLOYING: {
                title: 'Deploying the approved package',
                message: 'Providus Nexus is deploying only the validated components to the verified target org.',
                iconName: 'utility:upload',
                tone: 'active'
            },
            COMPLETED: {
                title: this.deploymentNotRequired ? 'Work completed without deployment' : 'Deployment completed',
                message: this.deploymentNotRequired
                    ? 'Validation confirmed that no Salesforce deployment was required.'
                    : this.deploymentSummaryText,
                iconName: 'utility:success',
                tone: 'success'
            }
        };
        return actions[this.status] || {
            title: this.statusDisplay,
            message: 'Providus Nexus is preparing the next supervised step.',
            iconName: 'utility:clock',
            tone: this.failedWorkflowStage ? 'error' : 'active'
        };
    }
    get currentActionClass() { return `current-action current-action--${this.currentAction.tone}`; }
    get workflowStageIndex() {
        if (['DEPLOYING', 'COMPLETED'].includes(this.status)) return 4;
        if (['VALIDATING', 'VALIDATION_FAILED', 'AWAITING_DEPLOYMENT_APPROVAL'].includes(this.status)) return 3;
        if (this.status === 'IMPLEMENTING') return 2;
        if (['AWAITING_PLAN_APPROVAL', 'PLAN_REJECTED'].includes(this.status)) return 1;
        return 0;
    }
    get failedWorkflowStage() {
        if (this.status === 'ORG_VERIFICATION_FAILED') return 'analysis';
        if (this.status === 'PLAN_REJECTED') return 'plan';
        if (this.status === 'VALIDATION_FAILED') return 'validation';
        if (this.status !== 'FAILED') return '';
        if (this.job?.deployment) return 'deployment';
        if (this.validation) return 'validation';
        if (this.implementationComplete) return 'implementation';
        return 'analysis';
    }
    get workflowStages() {
        const activeIndex = this.workflowStageIndex;
        return WORKFLOW_STAGES.map((stage, index) => {
            const failed = this.failedWorkflowStage === stage.key;
            const complete = !failed && (this.status === 'COMPLETED' || index < activeIndex);
            const active = !failed && this.status !== 'COMPLETED' && index === activeIndex;
            const stateClass = failed
                ? ' workflow-stage--failed milestone--failed'
                : complete
                    ? ' workflow-stage--complete milestone--complete'
                    : active
                        ? ' workflow-stage--active milestone--active'
                        : '';
            return {
                ...stage,
                label: this.workflowStageLabel(stage.key, stage.label),
                detail: this.workflowStageDetail(stage.key),
                iconName: failed ? 'utility:error' : complete ? 'utility:success' : active ? 'utility:sync' : 'utility:clock',
                className: `workflow-stage milestone${stateClass}`,
                ariaCurrent: active ? 'step' : null
            };
        });
    }
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
    get canRefreshAnalysis() { return ['RECEIVED', 'PLAN_REJECTED', 'ORG_VERIFICATION_FAILED', 'FAILED'].includes(this.status); }
    get canCancel() { return !['COMPLETED', 'FAILED', 'CANCELLED', 'DEPLOYING'].includes(this.status); }
    get canAddInstruction() { return this.hasJob && this.status !== 'CANCELLED'; }
    get instructionInputDisabled() { return this.isBusy || !this.canAddInstruction; }
    get instructionSendDisabled() { return this.instructionInputDisabled || !this.instruction.trim(); }
    get jobOptions() { return this.jobs.map((item) => ({ label: `${item.jiraIssueKey || 'Manual'} - ${item.status === 'ANALYZING_DEPENDENCIES' && item.currentActivity ? item.currentActivity : item.status}`, value: item.jobId })); }
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
        if (this.deploymentNotRequired) return 'Validation completed and no deployment was required because there were no Salesforce source changes.';
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
    get deploymentNotRequired() { return this.status === 'COMPLETED' && Boolean(this.job?.deployment?.notRequired); }
    get deploymentComplete() { return this.status === 'COMPLETED' && Boolean(this.job?.deployment) && !this.deploymentNotRequired; }
    get hasDeploymentItems() { return this.deploymentItems.length > 0; }
    get deploymentItems() { return (this.job?.deployment?.components || []).map((item, index) => ({ key: `deployment-${index}`, displayName: item.displayName || 'Deployment item', apiName: item.apiName || '', briefInfo: item.briefInfo || '' })); }
    get deploymentSummaryText() { return this.job?.deployment?.summary || ''; }
    get hasSpecialistWorkItems() { return this.specialistWorkItems.length > 0; }
    get specialistWorkItems() {
        return (this.job?.workItems || []).map((item) => ({
            key: item.workItemId,
            agentName: item.agentName,
            status: item.status.replaceAll('_', ' '),
            statusClass: `specialist-status specialist-status--${item.status.toLowerCase().replaceAll('_', '-')}`,
            responsibility: item.outputs?.analysisSummary || 'Specialist analysis is being prepared.',
            proposedWork: (item.outputs?.proposedChanges || []).join(' '),
            preserved: Boolean(item.preservedFromIteration),
            preservedText: item.preservedFromIteration ? `Preserved from iteration ${item.preservedFromIteration}` : ''
        }));
    }
    get specialistOverallStatus() { return (this.job?.specialistOverallStatus || 'PENDING').replaceAll('_', ' '); }
    get orchestrationIteration() { return this.job?.iteration || this.plan?.planVersion || 1; }
    get specialistToggleIcon() { return this.specialistsExpanded ? 'utility:chevronup' : 'utility:chevrondown'; }
    get specialistToggleTitle() { return this.specialistsExpanded ? 'Hide specialist details' : 'Show specialist details'; }
    get specialistProgressSummary() { return `${this.specialistWorkItems.length} specialists | Iteration ${this.orchestrationIteration}`; }
    get deploymentHowItWorks() { return this.job?.deployment?.specialistSummary?.howItWorks || this.expectedOutcome; }
    get deploymentValidationSummary() { return this.job?.deployment?.specialistSummary?.validationResult || ''; }
    get hasImplementationReports() { return this.implementationReportVersions.length > 0; }
    get implementationReportVersions() {
        return [...(this.job?.implementationReports || [])]
            .filter((report) => report.status === 'READY')
            .sort((left, right) => right.deploymentVersion - left.deploymentVersion)
            .map((report) => ({
                ...report,
                key: report.reportId || `implementation-report-v${report.deploymentVersion}`,
                versionLabel: `Deployment Version ${report.deploymentVersion}`,
                reportLabel: `Implementation Report V${report.deploymentVersion}`,
                generatedLabel: report.generatedAt ? new Date(report.generatedAt).toLocaleString() : ''
            }));
    }
    get implementationMilestoneClass() { return this.milestoneClass(this.implementationComplete, this.status === 'IMPLEMENTING'); }
    get validationMilestoneClass() { return this.validationFailed ? 'milestone milestone--failed' : this.milestoneClass(this.validationComplete, this.status === 'VALIDATING'); }
    get deploymentMilestoneClass() { return this.milestoneClass(this.deploymentComplete || this.deploymentNotRequired, this.status === 'DEPLOYING'); }
    get implementationMilestoneIcon() { return this.milestoneIcon(this.implementationComplete, this.status === 'IMPLEMENTING'); }
    get validationMilestoneIcon() { return this.validationFailed ? 'utility:error' : this.milestoneIcon(this.validationComplete, this.status === 'VALIDATING'); }
    get deploymentMilestoneIcon() { return this.milestoneIcon(this.deploymentComplete || this.deploymentNotRequired, this.status === 'DEPLOYING'); }
    get implementationMilestoneTitle() { return this.implementationComplete ? 'Local implementation completed' : this.status === 'IMPLEMENTING' ? 'Implementation in progress' : 'Implementation pending'; }
    get validationMilestoneTitle() { return this.validationFailed ? 'Validation failed' : this.validationComplete ? 'Validation passed' : this.status === 'VALIDATING' ? 'Validation in progress' : 'Validation pending'; }
    get deploymentMilestoneTitle() { return this.deploymentNotRequired ? 'Completed without deployment' : this.deploymentComplete ? 'Deployment completed' : this.status === 'DEPLOYING' ? 'Deployment in progress' : 'Deployment pending'; }
    get implementationMilestoneMessage() { return this.implementationComplete ? 'The approved changes were created locally and committed.' : 'Waiting for implementation approval and local execution.'; }
    get validationMilestoneMessage() { return this.validationFailed ? 'Salesforce rejected part of the proposed implementation.' : this.validationComplete ? `Salesforce validation passed for ${this.orgContext.displayName}.` : 'Validation starts after the local implementation is complete.'; }
    get deploymentMilestoneMessage() {
        if (this.deploymentNotRequired) return 'The job completed after validation. No deployment was required because there were no Salesforce source changes.';
        if (this.deploymentComplete) return `Successfully deployed to ${this.orgContext.displayName}. ${this.deploymentSummaryText || `Deployment ID: ${this.job.deployment.deploymentId || 'not returned'}.`}`;
        if (this.validationFailed) return 'Deployment is blocked until validation passes.';
        return 'A separate deployment approval is required after validation.';
    }
    get createDisabled() { return this.isBusy || (!this.prompt.trim() && !this.jiraIssueKey.trim()); }

    workflowStageLabel(stageKey, defaultLabel) {
        if (stageKey === 'deployment' && this.deploymentNotRequired) return 'Completed without deployment';
        if (stageKey === 'deployment' && this.deploymentComplete) return 'Deployment completed';
        if (stageKey === 'validation' && this.validationFailed) return 'Validation failed';
        return defaultLabel;
    }

    workflowStageDetail(stageKey) {
        if (stageKey === 'analysis') {
            return this.workflowStageIndex === 0 ? this.statusDisplay : 'Requirement and relevant metadata reviewed.';
        }
        if (stageKey === 'plan') {
            if (this.status === 'PLAN_REJECTED') return 'The proposal needs revision.';
            if (this.workflowStageIndex === 1) return 'Implementation plan ready for review.';
            return this.workflowStageIndex > 1 || this.status === 'COMPLETED' ? 'Implementation plan approved.' : 'Prepared after analysis.';
        }
        if (stageKey === 'implementation') {
            if (this.implementationComplete) return 'Approved local changes completed.';
            if (this.status === 'IMPLEMENTING') return 'Applying approved changes locally.';
            return 'Starts after implementation approval.';
        }
        if (stageKey === 'validation') {
            if (this.validationFailed) return this.validationFailureReason;
            if (this.validationComplete) return 'Salesforce validation passed.';
            if (this.status === 'VALIDATING') return 'Running Salesforce validation and tests.';
            return 'Runs after local implementation.';
        }
        if (this.deploymentNotRequired) return 'No deployment was required after validation.';
        if (this.deploymentComplete) return this.deploymentSummaryText || 'Approved components were deployed successfully.';
        if (this.status === 'DEPLOYING') return 'Deploying the approved package.';
        if (this.status === 'AWAITING_DEPLOYMENT_APPROVAL') return 'Separate deployment approval is required.';
        return 'Available after successful validation.';
    }

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
    handleToggleSpecialists() { this.specialistsExpanded = !this.specialistsExpanded; }
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
    async handleReload() {
        await this.run(async () => {
            await this.refreshJobs();
            if (this.hasJob) await this.refreshJob();
        });
    }
    async handleApproveImplementation() { await this.action('approve-implementation', { planVersion: this.plan.planVersion, comments: 'Approved in Salesforce agent console.' }); }
    async handleRejectPlan() { await this.action('reject-plan', { comments: 'Rejected in Salesforce agent console.' }); }
    async handleImplement() { await this.action('implement', {}); }
    async handleValidate() { await this.action('validate', {}); }
    async handleApproveDeployment() { await this.action('approve-deployment', { validationId: this.validation.validationId, productionSpecificApproval: this.isProduction, comments: this.hasDataOperations ? 'Salesforce data execution explicitly approved in the agent console.' : (this.isProduction ? 'Production deployment explicitly approved in Salesforce agent console.' : 'Deployment approved in Salesforce agent console.') }); }
    async handleRejectDeployment() { await this.action('reject-deployment', { comments: 'Deployment rejected in Salesforce agent console.' }); }
    async handleDeploy() { await this.action('deploy', {}); }
    async handleCancel() { await this.action('cancel', { reason: 'Cancelled in Salesforce agent console.' }); }
    async handleReportDownload(event) {
        const deploymentVersion = Number(event.currentTarget.dataset.version);
        const format = event.currentTarget.dataset.format;
        await this.run(async () => {
            const payload = this.parse(await getImplementationReport({ jobId: this.job.jobId, deploymentVersion, format }));
            this.downloadFile(payload);
        });
    }

    async action(action, payload) {
        await this.run(async () => {
            const response = this.parse(await performJobAction({ jobId: this.job.jobId, action, payloadJson: JSON.stringify(payload) }));
            await this.refreshJob();
            if (ACTIVE_STATES.has(this.status) || ['IMPLEMENTING', 'AWAITING_DEPLOYMENT_APPROVAL'].includes(this.status)) this.startPolling();
        });
    }

    async selectJob(jobId) {
        this.stopPolling();
        this.specialistsExpanded = false;
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
            orgContext: {
                customerName: '',
                displayName: '',
                environment: '',
                expectedOrgId: '',
                verified: { verifiedAt: '' },
                ...(job?.orgContext || {}),
                verified: { verifiedAt: job?.orgContext?.verified?.verifiedAt || '' }
            },
            metadataScope: job?.metadataScope || { primaryMetadata: [], dependencies: [] },
            workItems: job?.workItems || [],
            implementationReports: job?.implementationReports || []
        };
    }
    downloadFile(payload) {
        const binary = window.atob(payload.contentBase64 || '');
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const url = window.URL.createObjectURL(new Blob([bytes], { type: payload.contentType }));
        const link = document.createElement('a');
        link.href = url;
        link.download = payload.fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
    }
    listItems(values, prefix) { return values.map((text, index) => ({ key: `${prefix}-${index}`, text })); }
    milestoneClass(complete, active) { return `milestone${complete ? ' milestone--complete' : active ? ' milestone--active' : ''}`; }
    milestoneIcon(complete, active) { return complete ? 'utility:success' : active ? 'utility:sync' : 'utility:clock'; }
    normalizeError(error) { return error?.body?.message || error?.message || 'Unexpected error.'; }
}
