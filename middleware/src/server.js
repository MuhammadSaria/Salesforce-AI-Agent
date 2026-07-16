import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { logger } from './logger.js';
import { enqueueAgentJob } from './queue/agentQueue.js';
import { appendAudit, appendConversation, createJobRecord, getJobRecord, invalidateForOrgChange, invalidateForPlanChange, listJobRecords, transitionJob, updateJob } from './services/jobStore.js';
import { sanitizePrompt, sanitizeUntrustedText } from './utils/sanitize.js';
import { requireApiAuth, requireRole } from './middleware/auth.js';
import { getRegisteredOrg, listPublicOrgs } from './services/orgRegistry.js';
import { claimWebhookEvent, parseJiraWebhook, verifyJiraWebhook } from './services/jira.js';
import { JOB_STATES } from './domain/jobState.js';
import { startJiraPoller } from './services/jiraPoller.js';
import { latestApprovedApproval } from './domain/approval.js';
import { humanizeValidationFailure } from './utils/validationFailure.js';
import { approveSpecialistWorkItems, overallSpecialistStatus } from './services/orchestrator.js';
import { WORK_ITEM_STATUSES } from './domain/specialistAgents.js';
import { publicImplementationReport, readImplementationReportArtifact } from './services/implementationReport.js';
import { assertPlanActionable } from './domain/planActionability.js';
import { runtimeReadiness } from './services/runtimeHealth.js';
import { paginateJobSummaries } from './services/jobPresentation.js';

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: config.allowedOrigins.length ? config.allowedOrigins : false }));
  app.use(express.json({ limit: '64kb', verify: (req, res, buffer) => { req.rawBody = buffer; } }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (req, res) => res.json({ ok: true, service: 'providus-nexus-middleware' }));
  app.get('/ready', asyncRoute(async (req, res) => {
    const readiness = await runtimeReadiness();
    res.status(readiness.ready ? 200 : 503).json(readiness);
  }));
  app.post('/api/webhooks/jira', jiraWebhook);
  app.use('/api', requireApiAuth);

  app.get('/api/orgs', asyncRoute(async (req, res) => res.json({ orgs: await listPublicOrgs() })));
  app.get('/api/orgs/:orgId', asyncRoute(async (req, res) => {
    const org = await getRegisteredOrg(req.params.orgId);
    if (!org) return res.status(404).json({ error: { message: 'Org not found.' } });
    res.json({ org: { orgRegistryId: org.id, displayName: org.displayName, customerName: org.customerName, environment: org.environment, expectedOrgId: org.expectedOrgId, instanceUrl: org.instanceUrl, deploymentPermission: org.deploymentPermission, productionApprovalRequired: org.productionApprovalRequired } });
  }));

  app.post('/api/jobs', asyncRoute(async (req, res) => {
    const prompt = sanitizePrompt(req.body?.prompt || `Analyze Jira issue ${req.body?.jiraIssueKey || ''}`, config.maxPromptLength);
    const jiraIssueKey = normalizeIssueKey(req.body?.jiraIssueKey);
    const job = await createJobRecord({ jobId: nanoid(), prompt, jiraIssueKey, source: jiraIssueKey ? 'jira-manual' : 'manual', orgId: String(req.body?.orgId || ''), userId: req.actor.id, context: safeContext(req.body?.context) });
    await enqueueAgentJob({ jobId: job.jobId, action: 'analyze', actor: req.actor.id }, { jobId: `${job.jobId}:analyze:1` });
    res.status(201).json({ jobId: job.jobId, status: job.status, message: 'Job accepted for supervised analysis.' });
  }));

  app.get('/api/jobs', asyncRoute(async (req, res) => {
    res.json(paginateJobSummaries(await listJobRecords(), { limit: req.query.limit, cursor: req.query.cursor }));
  }));
  app.get('/api/jobs/:jobId', jobRoute((req, res, job) => res.json(publicJob(job))));
  app.get('/api/jobs/:jobId/plan', jobRoute((req, res, job) => res.json({ plan: job.plan })));
  app.get('/api/jobs/:jobId/validation', jobRoute((req, res, job) => res.json({ validation: job.validation })));
  app.get('/api/jobs/:jobId/diff', jobRoute((req, res, job) => res.type('text/plain').send(job.diff || '')));
  app.get('/api/jobs/:jobId/logs', jobRoute((req, res, job) => res.json({ logs: job.logs, commands: job.commands })));
  app.get('/api/jobs/:jobId/audit', jobRoute((req, res, job) => res.json({ stateHistory: job.stateHistory, audit: job.audit })));
  app.get('/api/jobs/:jobId/work-items', jobRoute((req, res, job) => res.json({ overallStatus: overallSpecialistStatus(job.workItems || []), workItems: job.workItems || [] })));
  app.get('/api/jobs/:jobId/specialist-messages', jobRoute((req, res, job) => res.json({ messages: job.specialistMessages || [] })));
  app.get('/api/jobs/:jobId/implementation-reports/:version/:format', jobRoute(async (req, res, job) => {
    const report = (job.implementationReports || []).find((item) => item.deploymentVersion === Number(req.params.version));
    if (!callerCanReadJob(req.actor, job, report)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This report belongs to a different Salesforce org.' } });
    const { artifact, buffer } = await readImplementationReportArtifact(job, req.params.version, req.params.format);
    res.set('Cache-Control', 'private, no-store');
    res.json({ fileName: artifact.fileName, contentType: artifact.contentType, contentBase64: buffer.toString('base64') });
  }));

  app.post('/api/jobs/:jobId/select-org', requireRole('developer', 'deployer', 'admin'), jobRoute(async (req, res, job) => {
    const org = await getRegisteredOrg(String(req.body?.orgRegistryId || ''));
    if (!org) return res.status(422).json({ error: { message: 'Select an active org from the registry.' } });
    const updated = await invalidateForOrgChange(job.jobId, org.id, req.actor.id);
    await enqueueAgentJob({ jobId: job.jobId, action: 'analyze', actor: req.actor.id }, { jobId: `${job.jobId}:analyze:${Date.now()}` });
    res.json({ jobId: updated.jobId, status: updated.status, message: 'Org selected. Prior artifacts and approvals were invalidated.' });
  }));

  app.post('/api/jobs/:jobId/analyze', requireRole('developer', 'deployer', 'admin'), jobRoute(async (req, res, job) => {
    if (![JOB_STATES.RECEIVED, JOB_STATES.AWAITING_REQUIREMENTS, JOB_STATES.PLAN_REJECTED, JOB_STATES.ORG_VERIFICATION_FAILED, JOB_STATES.FAILED].includes(job.status)) return conflict(res, 'Job is not ready for analysis.');
    if ([JOB_STATES.AWAITING_REQUIREMENTS, JOB_STATES.PLAN_REJECTED, JOB_STATES.FAILED].includes(job.status)) await invalidateForPlanChange(job.jobId, req.actor.id);
    await enqueueAgentJob({ jobId: job.jobId, action: 'analyze', actor: req.actor.id }, { jobId: `${job.jobId}:analyze:${Date.now()}` });
    res.status(202).json({ jobId: job.jobId, message: 'Analysis queued.' });
  }));

  app.post('/api/jobs/:jobId/instructions', requireRole('developer', 'deployer', 'admin'), jobRoute(async (req, res, job) => {
    const text = sanitizeUntrustedText(req.body?.instruction, 4000).trim();
    if (!text) return res.status(422).json({ error: { message: 'Instruction is required.' } });
    if (job.status === JOB_STATES.CANCELLED) return conflict(res, 'This job has been cancelled and cannot be revised.');
    const timestamp = new Date().toISOString();
    const instructionId = nanoid();
    const instructions = [...job.instructions, { instructionId, text, actor: req.actor.id, timestamp }];
    await updateJob(job.jobId, { instructions });
    await appendConversation(job.jobId, { conversationId: instructionId, role: 'user', kind: 'instruction', source: 'salesforce-ui', text, actor: req.actor.id, timestamp });
    const activeOperation = [JOB_STATES.IMPLEMENTING, JOB_STATES.VALIDATING, JOB_STATES.DEPLOYING].includes(job.status);
    let revised = await getJobRecord(job.jobId);
    if (activeOperation) {
      await updateJob(job.jobId, { pendingRevision: true, followUpRequired: true });
      await appendAudit(job.jobId, { actor: req.actor.id, action: 'USER_INSTRUCTION_ADDED', result: 'queued', safeMetadata: { instructionLength: text.length, currentStatus: job.status } });
      return res.status(202).json({ instructions, status: job.status, nextPlanVersion: revised.nextPlanVersion, message: 'Instruction accepted. It will be applied after the current operation finishes.' });
    }
    if (![JOB_STATES.RECEIVED, JOB_STATES.AWAITING_ORG_SELECTION].includes(job.status)) revised = await invalidateForPlanChange(job.jobId, req.actor.id, { instruction: text });
    await appendAudit(job.jobId, { actor: req.actor.id, action: 'USER_INSTRUCTION_ADDED', result: 'accepted', safeMetadata: { instructionLength: text.length, nextPlanVersion: revised.nextPlanVersion } });
    if (revised.status === JOB_STATES.RECEIVED) {
      await enqueueAgentJob({ jobId: job.jobId, action: 'analyze', actor: req.actor.id }, { jobId: `${job.jobId}:analyze:instruction:${Date.now()}` });
      return res.status(202).json({ instructions, status: revised.status, nextPlanVersion: revised.nextPlanVersion, message: 'Instruction accepted. Revised analysis queued.' });
    }
    res.status(201).json({ instructions, status: revised.status, nextPlanVersion: revised.nextPlanVersion, message: 'Instruction accepted. Select the target org to continue.' });
  }));

  app.post('/api/jobs/:jobId/approve-implementation', requireRole('developer', 'deployer', 'admin'), jobRoute(async (req, res, job) => {
    if (job.status !== JOB_STATES.AWAITING_PLAN_APPROVAL) return conflict(res, 'Job is not awaiting implementation approval.');
    if (Number(req.body?.planVersion) !== job.plan?.planVersion) return conflict(res, 'Approval must identify the current plan version.');
    assertPlanActionable(job.plan, job.requirement, job.jira);
    const approval = approvalRecord(job, req, 'IMPLEMENTATION', { decision: 'APPROVED' });
    await updateJob(job.jobId, { approvals: [...job.approvals, approval], workItems: approveSpecialistWorkItems(job.workItems || [], approval.approvalId) });
    await transitionJob(job.jobId, JOB_STATES.IMPLEMENTING, { actor: req.actor.id, reason: 'Explicit implementation approval recorded.', approvalId: approval.approvalId });
    await enqueueAgentJob({ jobId: job.jobId, action: 'implement', actor: req.actor.id }, { jobId: `${job.jobId}:implement:${Date.now()}` });
    res.status(201).json({ approval });
  }));
  app.post('/api/jobs/:jobId/reject-plan', requireRole('developer', 'deployer', 'admin'), jobRoute(async (req, res, job) => {
    if (job.status !== JOB_STATES.AWAITING_PLAN_APPROVAL) return conflict(res, 'Job is not awaiting plan review.');
    const approval = approvalRecord(job, req, 'IMPLEMENTATION', { decision: 'REJECTED' });
    await updateJob(job.jobId, {
      approvals: [...job.approvals, approval],
      workItems: (job.workItems || []).map((item) => [WORK_ITEM_STATUSES.COMPLETED, WORK_ITEM_STATUSES.CANCELLED].includes(item.status) ? item : { ...item, status: WORK_ITEM_STATUSES.CHANGES_REQUIRED, updatedAt: new Date().toISOString() })
    });
    await transitionJob(job.jobId, JOB_STATES.PLAN_REJECTED, { actor: req.actor.id, reason: 'Plan rejected.', approvalId: approval.approvalId });
    res.status(201).json({ approval });
  }));
  app.post('/api/jobs/:jobId/implement', requireRole('developer', 'deployer', 'admin'), queueAction('implement', [JOB_STATES.IMPLEMENTING, JOB_STATES.VALIDATION_FAILED]));
  app.post('/api/jobs/:jobId/validate', requireRole('developer', 'deployer', 'admin'), queueAction('validate', [JOB_STATES.IMPLEMENTING, JOB_STATES.VALIDATION_FAILED]));

  app.post('/api/jobs/:jobId/approve-deployment', requireRole('deployer', 'admin'), jobRoute(async (req, res, job) => {
    if (job.status !== JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL) return conflict(res, 'Job is not awaiting deployment approval.');
    if (req.body?.validationId !== job.validation?.validationId) return conflict(res, 'Approval must identify the current validation.');
    const approval = approvalRecord(job, req, 'DEPLOYMENT', { decision: 'APPROVED', validationId: job.validation.validationId, validatedSourceHash: job.validation.sourceHash, gitCommitHash: job.validation.commitHash || '', deploymentPackageHash: job.validation.packageHash, productionSpecificApproval: req.body?.productionSpecificApproval === true });
    await updateJob(job.jobId, { approvals: [...job.approvals, approval] });
    res.status(201).json({ approval });
  }));
  app.post('/api/jobs/:jobId/reject-deployment', requireRole('deployer', 'admin'), jobRoute(async (req, res, job) => {
    if (job.status !== JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL) return conflict(res, 'Job is not awaiting deployment approval.');
    const approval = approvalRecord(job, req, 'DEPLOYMENT', { decision: 'REJECTED', validationId: job.validation?.validationId });
    await updateJob(job.jobId, { approvals: [...job.approvals, approval] });
    res.status(201).json({ approval });
  }));
  app.post('/api/jobs/:jobId/deploy', requireRole('deployer', 'admin'), jobRoute(async (req, res, job) => {
    if (job.status !== JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL) return conflict(res, 'Job is not ready to deploy.');
    const approval = latestApprovedApproval(job, 'DEPLOYMENT', job.validation?.validationId);
    if (!approval) return conflict(res, 'Explicit deployment approval is required.');
    await transitionJob(job.jobId, JOB_STATES.DEPLOYING, { actor: req.actor.id, reason: 'Deployment requested after explicit approval.', approvalId: approval.approvalId });
    await enqueueAgentJob({ jobId: job.jobId, action: 'deploy', actor: req.actor.id }, { jobId: `${job.jobId}:deploy:${Date.now()}` });
    res.status(202).json({ jobId: job.jobId, message: 'Approved deployment queued.' });
  }));
  app.post('/api/jobs/:jobId/cancel', requireRole('developer', 'deployer', 'admin'), jobRoute(async (req, res, job) => {
    await transitionJob(job.jobId, JOB_STATES.CANCELLED, { actor: req.actor.id, reason: sanitizeUntrustedText(req.body?.reason, 500) || 'Cancelled by user.' });
    res.json({ jobId: job.jobId, status: JOB_STATES.CANCELLED });
  }));

  app.use(errorHandler);
  return app;
}

async function jiraWebhook(req, res, next) {
  try {
    verifyJiraWebhook(req.rawBody || Buffer.from(''), req.get('x-hub-signature') || req.get('x-agent-webhook-signature'), req.get('x-agent-webhook-token'));
    const parsed = parseJiraWebhook(req.body);
    const eventId = String(req.get('x-atlassian-webhook-identifier') || `${parsed.event}:${parsed.issue.key}:${req.body?.timestamp || ''}`);
    if (!(await claimWebhookEvent(eventId))) return res.status(200).json({ accepted: true, duplicate: true });
    const existing = (await listJobRecords()).find((job) => job.jiraIssueKey === parsed.issue.key);
    if (existing) {
      await enqueueAgentJob({ jobId: existing.jobId, action: 'sync-jira', actor: 'jira-webhook' }, { jobId: `${existing.jobId}:jira-sync:${Date.now()}` });
      return res.status(202).json({ accepted: true, updateQueued: true, jobId: existing.jobId });
    }
    const job = await createJobRecord({ jobId: nanoid(), jiraIssueKey: parsed.issue.key, source: 'jira-webhook', prompt: `Analyze Jira issue ${parsed.issue.key}`, userId: 'jira-webhook', context: { jiraProjectKey: parsed.issue.projectKey, jiraComponents: parsed.issue.components, jiraCustomFields: parsed.issue.customFields }, jira: parsed.issue });
    await enqueueAgentJob({ jobId: job.jobId, action: 'analyze', actor: 'jira-webhook' }, { jobId: `${job.jobId}:analyze:1` });
    res.status(202).json({ accepted: true, jobId: job.jobId });
  } catch (error) { next(error); }
}

function queueAction(action, states) { return jobRoute(async (req, res, job) => { if (!states.includes(job.status)) return conflict(res, `Job is not ready to ${action}.`); await enqueueAgentJob({ jobId: job.jobId, action, actor: req.actor.id }, { jobId: `${job.jobId}:${action}:${Date.now()}` }); res.status(202).json({ jobId: job.jobId, message: `${action} queued.` }); }); }
function jobRoute(handler) { return asyncRoute(async (req, res) => { const job = await getJobRecord(req.params.jobId); if (!job) return res.status(404).json({ error: { message: 'Job not found.' } }); return handler(req, res, job); }); }
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function approvalRecord(job, req, type, extra) { return { approvalId: nanoid(), jobId: job.jobId, jiraIssueKey: job.jiraIssueKey, approvalType: type, planVersion: job.plan?.planVersion, planHash: job.plan?.planHash, materialChangeHash: job.plan?.materialChangeHash || '', metadataScopeHash: job.metadataScope?.hash, orgRegistryId: job.orgContext?.orgRegistryId, salesforceOrganizationId: job.orgContext?.expectedOrgId, environment: job.orgContext?.environment, approverIdentity: req.actor.id, comments: sanitizeUntrustedText(req.body?.comments, 1000), approvalTimestamp: new Date().toISOString(), ...extra }; }
function publicJob(job) {
  const safe = { ...job };
  if (safe.jira) {
    safe.jira = {
      ...safe.jira,
      attachmentContents: (safe.jira.attachmentContents || []).map(({ id, filename, mimeType, truncated }) => ({ id, filename, mimeType, truncated }))
    };
  }
  if (safe.requirement) {
    safe.requirement = { ...safe.requirement };
    delete safe.requirement.attachmentRequirements;
  }
  safe.specialistOverallStatus = overallSpecialistStatus(job.workItems || []);
  safe.revisions = (job.revisions || []).map((revision) => ({
    revisionNumber: revision.revisionNumber,
    invalidatedAt: revision.invalidatedAt,
    invalidatedBy: revision.invalidatedBy,
    reason: revision.reason,
    orgDisplayName: revision.orgContext?.displayName || '',
    planVersion: revision.plan?.planVersion || revision.revisionNumber,
    implementationCompleted: Boolean(revision.implementation),
    validationStatus: revision.validation?.status || '',
    approvalsInvalidated: (revision.approvals || []).length
  }));
  safe.conversation = (job.conversation || []).map((entry) => ({
    conversationId: entry.conversationId || '',
    role: entry.role || 'user',
    kind: entry.kind || 'message',
    source: entry.source || '',
    text: entry.text || '',
    actor: entry.actor || '',
    timestamp: entry.timestamp || '',
    responseToMessageId: entry.responseToMessageId || ''
  }));
  safe.implementationReports = (job.implementationReports || []).map(publicImplementationReport);
  safe.deploymentHistory = (job.deploymentHistory || []).map((deployment) => ({
    deploymentVersion: deployment.deploymentVersion,
    deployedAt: deployment.deployedAt,
    targetOrg: deployment.targetOrgDisplayName || '',
    environment: deployment.environment || '',
    summary: deployment.summary || '',
    reportStatus: deployment.implementationReport?.status || ''
  }));
  if (safe.validation?.status === 'FAILED') {
    safe.validation = { ...safe.validation, failureReason: safe.validation.failureReason || humanizeValidationFailure(safe.validation.error || safe.error) };
  }
  delete safe.prompt;
  return safe;
}
function callerCanReadJob(actor, job, report) {
  if (actor?.authMethod === 'bearer') return true;
  const callerOrg = String(actor?.orgId || '').slice(0, 15).toUpperCase();
  const targetOrg = String(report?.salesforceOrganizationId || job.orgContext?.expectedOrgId || job.deployment?.targetOrgId || '').slice(0, 15).toUpperCase();
  return Boolean(callerOrg && targetOrg && callerOrg === targetOrg);
}
function safeContext(context) { return { selectedOrgRegistryId: String(context?.selectedOrgRegistryId || ''), customerName: String(context?.customerName || ''), environment: String(context?.environment || '') }; }
function normalizeIssueKey(value) { const key = String(value || '').trim().toUpperCase(); if (key && !/^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/.test(key)) throw Object.assign(new Error('Invalid Jira issue key.'), { statusCode: 422 }); return key; }
function conflict(res, message) { return res.status(409).json({ error: { message } }); }
function errorHandler(error, req, res, _next) { req.log?.error({ err: error, code: error.code }, 'Request failed'); res.status(error.statusCode || 500).json({ error: { code: error.code || 'REQUEST_FAILED', message: error.message || 'Unexpected middleware error.' } }); }

if (process.env.NODE_ENV !== 'test') createApp().listen(config.port, () => {
  logger.info({ port: config.port }, 'Agent middleware listening');
  startJiraPoller();
});
