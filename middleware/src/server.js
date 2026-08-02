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
import { applySalesforceClaims, requireApiAuth, requireRole, requireSalesforceClaims } from './middleware/auth.js';
import { getRegisteredOrg, listPublicOrgs } from './services/orgRegistry.js';
import { claimWebhookEvent, parseJiraWebhook, verifyJiraWebhook } from './services/jira.js';
import { JOB_STATES } from './domain/jobState.js';
import { startJiraPoller } from './services/jiraPoller.js';
import { orgBoundApproval } from './domain/approval.js';
import { assertArchitecturePlanActionable } from './domain/planActionability.js';
import { approveSpecialistWorkItems, overallSpecialistStatus } from './services/orchestrator.js';
import { WORK_ITEM_STATUSES } from './domain/specialistAgents.js';
import { publicJob } from './services/jobPresentation.js';
import { conversationService } from './services/conversationService.js';
import { runtimeReadiness } from './services/runtimeHealth.js';
import { resolveSameOrg } from './services/sameOrgService.js';
import { sameSalesforceId } from './utils/salesforceId.js';

export function createApp(options = {}) {
  const app = express();
  const sameOrgResolver = options.resolveSameOrg || resolveSameOrg;
  app.use(helmet());
  app.use(cors({ origin: config.allowedOrigins.length ? config.allowedOrigins : false }));
  app.use(express.json({ limit: '64kb', verify: (req, res, buffer) => { req.rawBody = buffer; } }));
  app.use(pinoHttp({ logger }));
  const enqueue = options.enqueue || enqueueAgentJob;
  const conversations = conversationService({
    repository: jobStoreRepository(),
    enqueue
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/ready', asyncRoute(async (req, res) => {
    const readiness = await runtimeReadiness();
    res.status(readiness.ready ? 200 : 503).json(readiness);
  }));
  if (config.jiraEnabled) app.post('/api/webhooks/jira', jiraWebhook);
  app.use('/api', requireApiAuth);

  app.get('/api/orgs', asyncRoute(async (req, res) => res.json({ orgs: await listPublicOrgs() })));
  app.get('/api/orgs/:orgId', asyncRoute(async (req, res) => {
    const org = await getRegisteredOrg(req.params.orgId);
    if (!org) return res.status(404).json({ error: { message: 'Org not found.' } });
    res.json({ org: { orgRegistryId: org.id, displayName: org.displayName, customerName: org.customerName, environment: org.environment, expectedOrgId: org.expectedOrgId, instanceUrl: org.instanceUrl, deploymentPermission: org.deploymentPermission, productionApprovalRequired: org.productionApprovalRequired } });
  }));

  app.post('/api/jobs', requireDirectSalesforceClaims, asyncRoute(async (req, res) => {
    if (!String(req.body?.prompt || '').trim()) return promptRequired(res);
    const prompt = sanitizePrompt(req.body.prompt, config.maxPromptLength).trim();
    const orgContext = req.actor.authMode === 'test-bypass' && !req.actor.orgId
      ? null
      : await sameOrgResolver({ authenticatedOrgId: req.actor.orgId, actorId: req.actor.id });
    const outcome = await conversations.start({ actor: req.actor, prompt, orgId: req.actor?.orgId || '', context: safeContext(), orgContext });
    res.status(201).json(outcome);
  }));

  app.get('/api/jobs', requireDirectSalesforceClaims, asyncRoute(async (req, res) => {
    const jobs = (await listJobRecords()).filter((job) => canListJob(req.actor, job)).map(publicJob);
    res.json({ jobs });
  }));
  app.get('/api/jobs/:jobId', jobRoute((req, res, job) => res.json(publicJob(job))));
  app.get('/api/jobs/:jobId/plan', jobRoute((req, res, job) => res.json({ plan: job.plan })));
  app.get('/api/jobs/:jobId/validation', jobRoute((req, res, job) => res.json({ validation: job.validation })));
  app.get('/api/jobs/:jobId/diff', jobRoute((req, res, job) => res.type('text/plain').send(job.diff || '')));
  app.get('/api/jobs/:jobId/logs', jobRoute((req, res, job) => res.json({ logs: job.logs, commands: job.commands })));
  app.get('/api/jobs/:jobId/audit', jobRoute((req, res, job) => res.json({ stateHistory: job.stateHistory, audit: job.audit })));
  app.get('/api/jobs/:jobId/work-items', jobRoute((req, res, job) => res.json({ overallStatus: overallSpecialistStatus(job.workItems || []), workItems: job.workItems || [] })));
  app.get('/api/jobs/:jobId/specialist-messages', jobRoute((req, res, job) => res.json({ messages: job.specialistMessages || [] })));

  app.post('/api/jobs/:jobId/messages', mutableJobRoute(async (req, res, job) => {
    const text = sanitizeUntrustedText(req.body?.text, 4000).trim();
    if (!text) return res.status(422).json({ error: { code: 'MESSAGE_REQUIRED', message: 'Enter a message.' } });
    const outcome = await conversations.append({ job, actor: req.actor, text });
    res.status(202).json(outcome);
  }));

  app.post('/api/jobs/:jobId/select-org', requireRole('developer', 'deployer', 'admin'), mutableJobRoute(async (req, res, job) => {
    if (job.source === 'salesforce-chat') return conflict(res, 'Direct Phase 1 actions must use the authenticated same Salesforce sandbox.');
    const org = await getRegisteredOrg(String(req.body?.orgRegistryId || ''));
    if (!org) return res.status(422).json({ error: { message: 'Select an active org from the registry.' } });
    const updated = await invalidateForOrgChange(job.jobId, org.id, req.actor.id);
    await enqueue({ jobId: job.jobId, action: 'analyze', actor: req.actor.id }, { jobId: `${job.jobId}:analyze:${Date.now()}` });
    res.json({ jobId: updated.jobId, status: updated.status, message: 'Org selected. Prior artifacts and approvals were invalidated.' });
  }));

  if (config.jiraEnabled) {
    app.post('/api/jobs/:jobId/analyze', requireRole('developer', 'deployer', 'admin'), mutableJobRoute(async (req, res, job) => {
      if (job.source === 'salesforce-chat') return conflict(res, 'Direct Salesforce chat jobs continue through conversation messages.');
      if (![JOB_STATES.RECEIVED, JOB_STATES.PLAN_REJECTED, JOB_STATES.ORG_VERIFICATION_FAILED].includes(job.status)) return conflict(res, 'Job is not ready for analysis.');
      if (job.status === JOB_STATES.PLAN_REJECTED) await invalidateForPlanChange(job.jobId, req.actor.id);
      await enqueue({ jobId: job.jobId, action: 'analyze', actor: req.actor.id }, { jobId: `${job.jobId}:analyze:${Date.now()}` });
      res.status(202).json({ jobId: job.jobId, message: 'Analysis queued.' });
    }));

    app.post('/api/jobs/:jobId/instructions', requireRole('developer', 'deployer', 'admin'), mutableJobRoute(async (req, res, job) => {
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
        await enqueue({ jobId: job.jobId, action: 'analyze', actor: req.actor.id }, { jobId: `${job.jobId}:analyze:instruction:${Date.now()}` });
        return res.status(202).json({ instructions, status: revised.status, nextPlanVersion: revised.nextPlanVersion, message: 'Instruction accepted. Revised analysis queued.' });
      }
      res.status(201).json({ instructions, status: revised.status, nextPlanVersion: revised.nextPlanVersion, message: 'Instruction accepted. Select the target org to continue.' });
    }));
  }

  app.post('/api/jobs/:jobId/approve-implementation', mutableJobRoute(async (req, res, job) => {
    if (!requireImplementationPermission(req, res, job)) return;
    if (!isAwaitingImplementationApproval(job)) return conflict(res, 'Job is not awaiting implementation approval.');
    if (!assertImplementationApprovalBinding(req, res, job)) return;
    const approval = approvalRecord(job, req, 'IMPLEMENTATION', { decision: 'APPROVED' });
    await updateJob(job.jobId, { approvals: [...job.approvals, approval], workItems: approveSpecialistWorkItems(job.workItems || [], approval.approvalId) });
    await transitionJob(job.jobId, JOB_STATES.IMPLEMENTING, { actor: req.actor.id, reason: 'Explicit implementation approval recorded.', approvalId: approval.approvalId });
    await enqueue({ jobId: job.jobId, action: 'implement', actor: req.actor.id }, { jobId: `${job.jobId}:implement:${Date.now()}` });
    res.status(201).json({ approval });
  }));
  app.post('/api/jobs/:jobId/reject-plan', mutableJobRoute(async (req, res, job) => {
    if (!requireImplementationPermission(req, res, job)) return;
    if (!isAwaitingImplementationApproval(job)) return conflict(res, 'Job is not awaiting plan review.');
    const approval = approvalRecord(job, req, 'IMPLEMENTATION', { decision: 'REJECTED' });
    await updateJob(job.jobId, {
      approvals: [...job.approvals, approval],
      workItems: (job.workItems || []).map((item) => [WORK_ITEM_STATUSES.COMPLETED, WORK_ITEM_STATUSES.CANCELLED].includes(item.status) ? item : { ...item, status: WORK_ITEM_STATUSES.CHANGES_REQUIRED, updatedAt: new Date().toISOString() })
    });
    await transitionJob(job.jobId, JOB_STATES.PLAN_REJECTED, { actor: req.actor.id, reason: 'Plan rejected.', approvalId: approval.approvalId });
    res.status(201).json({ approval });
  }));
  app.post('/api/jobs/:jobId/implement', queueAction('implement', [JOB_STATES.IMPLEMENTING, JOB_STATES.VALIDATION_FAILED], requireImplementationPermission, 'IMPLEMENTATION', { enqueue, sameOrgResolver }));
  app.post('/api/jobs/:jobId/validate', queueAction('validate', [JOB_STATES.IMPLEMENTING, JOB_STATES.VALIDATION_FAILED], requireImplementationPermission, 'IMPLEMENTATION', { enqueue, sameOrgResolver }));

  app.post('/api/jobs/:jobId/approve-deployment', mutableJobRoute(async (req, res, job) => {
    if (!requireDeploymentPermission(req, res, job)) return;
    if (job.status !== JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL) return conflict(res, 'Job is not awaiting deployment approval.');
    if (req.body?.validationId !== job.validation?.validationId) return conflict(res, 'Approval must identify the current validation.');
    const approval = approvalRecord(job, req, 'DEPLOYMENT', { decision: 'APPROVED', validationId: job.validation.validationId, validatedSourceHash: job.validation.sourceHash, gitCommitHash: job.validation.commitHash || '', deploymentPackageHash: job.validation.packageHash, productionSpecificApproval: req.body?.productionSpecificApproval === true });
    await updateJob(job.jobId, { approvals: [...job.approvals, approval] });
    res.status(201).json({ approval });
  }));
  app.post('/api/jobs/:jobId/reject-deployment', mutableJobRoute(async (req, res, job) => {
    if (!requireDeploymentPermission(req, res, job)) return;
    if (job.status !== JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL) return conflict(res, 'Job is not awaiting deployment approval.');
    const approval = approvalRecord(job, req, 'DEPLOYMENT', { decision: 'REJECTED', validationId: job.validation?.validationId });
    await updateJob(job.jobId, { approvals: [...job.approvals, approval] });
    res.status(201).json({ approval });
  }));
  app.post('/api/jobs/:jobId/deploy', mutableJobRoute(async (req, res, job) => {
    if (!requireDeploymentPermission(req, res, job)) return;
    if (job.status !== JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL) return conflict(res, 'Job is not ready to deploy.');
    const orgContext = await trustedOrgContextForJob(job, req.actor, sameOrgResolver);
    const approval = orgBoundApproval(job, 'DEPLOYMENT', { orgContext });
    assertDeploymentApprovalReady(job, approval, orgContext);
    if (job.source === 'salesforce-chat') await updateJob(job.jobId, { orgContext });
    await transitionJob(job.jobId, JOB_STATES.DEPLOYING, { actor: req.actor.id, reason: 'Deployment requested after explicit approval.', approvalId: approval.approvalId });
    await enqueue({ jobId: job.jobId, action: 'deploy', actor: req.actor.id }, { jobId: `${job.jobId}:deploy:${Date.now()}` });
    res.status(202).json({ jobId: job.jobId, message: 'Approved deployment queued.' });
  }));
  app.post('/api/jobs/:jobId/cancel', mutableJobRoute(async (req, res, job) => {
    const outcome = await conversations.cancel({ job, actor: req.actor, reason: sanitizeUntrustedText(req.body?.reason, 500).trim() });
    res.json(outcome);
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

async function trustedOrgContextForJob(job, actor, sameOrgResolver) {
  if (!isSalesforceChat(job)) return job.orgContext;
  const orgContext = await sameOrgResolver({ authenticatedOrgId: job.orgId, actorId: actor.id });
  if (!sameSalesforceId(orgContext?.expectedOrgId, job.orgId)) throw Object.assign(new Error('Resolved Salesforce org context does not match this job.'), { statusCode: 409 });
  return orgContext;
}

function queueAction(action, states, permission, approvalType = '', dependencies = {}) {
  return mutableJobRoute(async (req, res, job) => {
    if (permission && !permission(req, res, job)) return;
    if (!states.includes(job.status)) return conflict(res, `Job is not ready to ${action}.`);
    if (approvalType) {
      const orgContext = await trustedOrgContextForJob(job, req.actor, dependencies.sameOrgResolver || resolveSameOrg);
      orgBoundApproval(job, approvalType, { orgContext });
      if (job.source === 'salesforce-chat') await updateJob(job.jobId, { orgContext });
    }
    await (dependencies.enqueue || enqueueAgentJob)({ jobId: job.jobId, action, actor: req.actor.id }, { jobId: `${job.jobId}:${action}:${Date.now()}` });
    res.status(202).json({ jobId: job.jobId, message: `${action} queued.` });
  });
}
function assertDeploymentApprovalReady(job, approval, orgContext) {
  const validation = job.validation;
  if (!validation || validation.status !== 'PASSED' || new Date(validation.expiryTimestamp) <= new Date()) {
    throw Object.assign(new Error('A current deployment approval for this exact plan, scope, and org is required.'), { statusCode: 409, code: 'APPROVAL_REQUIRED' });
  }
  if (approval.validatedSourceHash !== validation.sourceHash || approval.deploymentPackageHash !== validation.packageHash) {
    throw Object.assign(new Error('A current deployment approval for this exact plan, scope, and org is required.'), { statusCode: 409, code: 'APPROVAL_REQUIRED' });
  }
  if (!sameSalesforceId(validation.targetOrgId, orgContext?.expectedOrgId)) {
    throw Object.assign(new Error('A current deployment approval for this exact plan, scope, and org is required.'), { statusCode: 409, code: 'APPROVAL_REQUIRED' });
  }
}
function requireDirectSalesforceClaims(req, res, next) { return req.actor?.authMode === 'test-bypass' && !req.get('x-agent-source') ? next() : requireSalesforceClaims(req, res, next); }
function requireImplementationPermission(req, res, job) { if (requiresSalesforceClaims(req, res, job)) return false; if (hasImplementationPermission(req.actor, job)) return true; res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This action is not permitted.' } }); return false; }
function requireDeploymentPermission(req, res, job) { if (requiresSalesforceClaims(req, res, job)) return false; if (hasDeploymentPermission(req.actor, job)) return true; res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This action is not permitted.' } }); return false; }
function jobRoute(handler) { return asyncRoute(async (req, res) => { const job = await getJobRecord(req.params.jobId); if (!job) return res.status(404).json({ error: { message: 'Job not found.' } }); if (requiresSalesforceClaims(req, res, job)) return; if (!canAccessJob(req.actor, job)) return res.status(404).json({ error: { message: 'Job not found.' } }); return handler(req, res, job); }); }
function mutableJobRoute(handler) { return jobRoute((req, res, job) => isJiraSource(job) && !config.jiraEnabled ? jiraDisabled(res) : handler(req, res, job)); }
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function approvalRecord(job, req, type, extra) { return { approvalId: nanoid(), jobId: job.jobId, jiraIssueKey: job.jiraIssueKey, approvalType: type, planVersion: job.plan?.planVersion, planHash: job.plan?.planHash, materialChangeHash: job.plan?.materialChangeHash || '', metadataScopeHash: job.metadataScope?.hash, orgRegistryId: job.orgContext?.orgRegistryId, salesforceOrganizationId: isSalesforceChat(job) ? req.actor?.orgId : job.orgContext?.expectedOrgId, environment: job.orgContext?.environment, approverIdentity: req.actor.id, comments: sanitizeUntrustedText(req.body?.comments, 1000), approvalTimestamp: new Date().toISOString(), ...extra }; }
function assertImplementationApprovalBinding(req, res, job) {
  if (Number(req.body?.planVersion) !== job.plan?.planVersion) {
    conflict(res, 'Approval must identify the current plan version.');
    return false;
  }
  if (String(req.body?.planHash || '') !== String(job.plan?.planHash || '')) {
    conflict(res, 'Approval must identify the current plan hash.');
    return false;
  }
  if (String(req.body?.scopeHash || '') !== String(job.metadataScope?.hash || job.plan?.scopeHash || '')) {
    conflict(res, 'Approval must identify the current scope hash.');
    return false;
  }
  try {
    assertArchitecturePlanActionable(job.plan);
  } catch (error) {
    res.status(error.statusCode || 409).json({ error: { code: error.code || 'PLAN_NOT_ACTIONABLE', message: error.message } });
    return false;
  }
  return true;
}
function safeContext() { return { selectedOrgRegistryId: '', customerName: '', environment: '' }; }
function conflict(res, message) { return res.status(409).json({ error: { message } }); }
function promptRequired(res) { return res.status(422).json({ error: { code: 'PROMPT_REQUIRED', message: 'Enter a Salesforce development request.' } }); }
function jiraDisabled(res) { return res.status(409).json({ error: { code: 'JIRA_DISABLED', message: 'Jira workflows are disabled.' } }); }
function errorHandler(error, req, res, _next) { req.log?.error({ err: error, code: error.code }, 'Request failed'); res.status(error.statusCode || 500).json({ error: { code: error.code || 'REQUEST_FAILED', message: error.message || 'Unexpected middleware error.' } }); }
function requiresSalesforceClaims(req, res, job) {
  if (!isSalesforceChat(job) || isSalesforceClaimsActor(req.actor) || req.actor?.authMode === 'test-bypass') return false;
  if (req.actor?.authMode === 'trusted-internal-service' && req.get('x-agent-source')) {
    try {
      applySalesforceClaims(req);
      return false;
    } catch (error) {
      res.status(401).json({ error: { code: 'SALESFORCE_CLAIMS_REQUIRED', message: error.message } });
      return true;
    }
  }
  res.status(401).json({ error: { code: 'SALESFORCE_CLAIMS_REQUIRED', message: 'Authenticated Salesforce identity claims are required for this job.' } });
  return true;
}
function canListJob(actor, job) {
  if (!isSalesforceChat(job)) return actor?.role === 'admin' || job.userId === actor?.id;
  return sameSalesforceJobOrg(actor, job) && (job.userId === actor?.id || actor?.canImplement === true);
}
function canAccessJob(actor, job) {
  if (!isSalesforceChat(job)) return actor?.role === 'admin' || job.userId === actor?.id;
  return sameSalesforceJobOrg(actor, job) && (job.userId === actor?.id || actor?.canImplement === true || actor?.canDeploy === true);
}
function hasImplementationPermission(actor, job) {
  if (isSalesforceChat(job)) return sameSalesforceJobOrg(actor, job) && actor?.canImplement === true;
  return actor?.authMode === 'test-bypass' && actor?.role === 'admin';
}
function hasDeploymentPermission(actor, job) {
  if (isSalesforceChat(job)) return sameSalesforceJobOrg(actor, job) && actor?.canDeploy === true;
  return actor?.authMode === 'test-bypass' && (actor?.role === 'admin' || actor?.role === 'deployer');
}
function sameSalesforceJobOrg(actor, job) {
  if (!isSalesforceChat(job)) return true;
  if (actor?.authMode === 'test-bypass' && !actor?.orgId) return true;
  return Boolean(actor?.orgId && job?.orgId && sameSalesforceId(actor.orgId, job.orgId));
}
function isSalesforceClaimsActor(actor) { return actor?.authMode === 'salesforce-claims'; }
function isSalesforceChat(job) { return job.source === 'salesforce-chat'; }
function isAwaitingImplementationApproval(job) { return [JOB_STATES.AWAITING_PLAN_APPROVAL, JOB_STATES.AWAITING_IMPLEMENTATION_APPROVAL].includes(job.status); }
function isJiraSource(job) { return Boolean(job.jiraIssueKey || String(job.source || '').startsWith('jira-')); }
function jobStoreRepository() {
  return {
    create: createJobRecord,
    appendConversation,
    appendAudit,
    transition: transitionJob
  };
}

if (process.env.NODE_ENV !== 'test') createApp().listen(config.port, () => {
  logger.info({ port: config.port }, 'Agent middleware listening');
  if (config.jiraEnabled) startJiraPoller();
});
