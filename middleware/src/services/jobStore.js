import { redis } from '../queue/connection.js';
import { assertTransition, JOB_STATES } from '../domain/jobState.js';

const memoryJobs = new Map();
const keyFor = (jobId) => `agent-job:${jobId}`;

export async function createJobRecord(input) {
  const now = new Date().toISOString();
  const record = {
    jobId: input.jobId,
    jiraIssueKey: input.jiraIssueKey || '',
    source: input.source || 'manual',
    status: JOB_STATES.RECEIVED,
    prompt: input.prompt || '',
    orgId: input.orgId || '',
    userId: input.userId || '',
    context: input.context || {},
    orgContext: null,
    orgCandidates: [],
    jira: null,
    metadataScope: null,
    plan: null,
    instructions: [],
    approvals: [],
    validation: null,
    deployment: null,
    diff: '',
    logs: [{ timestamp: now, level: 'info', message: 'Job received.' }],
    commands: [],
    stateHistory: [{ previousState: null, newState: JOB_STATES.RECEIVED, timestamp: now, actor: input.userId || 'system', reason: 'Job created', approvalId: '', orgId: '' }],
    audit: [],
    error: '',
    createdAt: now,
    updatedAt: now
  };
  await save(record);
  return record;
}

export async function getJobRecord(jobId) {
  const raw = redis ? await redis.hget(keyFor(jobId), 'record') : memoryJobs.get(jobId);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
}

export async function listJobRecords() {
  if (!redis) return [...memoryJobs.values()].map(structuredClone);
  const ids = await redis.smembers('agent-jobs:index');
  return (await Promise.all(ids.map(getJobRecord))).filter(Boolean);
}

export async function updateJob(jobId, patch) {
  const record = await requiredJob(jobId);
  Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  await save(record);
  return record;
}

export async function transitionJob(jobId, newState, details = {}) {
  const record = await requiredJob(jobId);
  assertTransition(record.status, newState);
  const event = {
    previousState: record.status,
    newState,
    timestamp: new Date().toISOString(),
    actor: details.actor || 'system',
    reason: details.reason || '',
    approvalId: details.approvalId || '',
    orgId: record.orgContext?.expectedOrgId || ''
  };
  record.status = newState;
  record.stateHistory.push(event);
  record.updatedAt = event.timestamp;
  if (details.error) record.error = details.error;
  await save(record);
  return record;
}

export async function appendLog(jobId, level, message) {
  const record = await requiredJob(jobId);
  record.logs.push({ timestamp: new Date().toISOString(), level, message: String(message).slice(0, 4000) });
  await save(record);
}

export async function appendCommand(jobId, commandLog) {
  const record = await requiredJob(jobId);
  record.commands.push({ timestamp: new Date().toISOString(), ...commandLog });
  await save(record);
}

export async function appendAudit(jobId, event) {
  const record = await requiredJob(jobId);
  record.audit.push({ timestamp: new Date().toISOString(), ...event });
  await save(record);
}

export async function invalidateForOrgChange(jobId, selection, actor) {
  return invalidate(jobId, selection, actor, 'Target org changed; plan, approvals, validation, hashes, and deployment package invalidated.');
}

export async function invalidateForPlanChange(jobId, actor) {
  const record = await requiredJob(jobId);
  return invalidate(jobId, record.orgContext?.orgRegistryId || record.context?.selectedOrgRegistryId || '', actor, 'Requirements changed; plan, approvals, validation, hashes, and deployment package invalidated.');
}

async function invalidate(jobId, selection, actor, reason) {
  const record = await requiredJob(jobId);
  if ([JOB_STATES.COMPLETED, JOB_STATES.CANCELLED, JOB_STATES.DEPLOYING].includes(record.status)) {
    throw Object.assign(new Error('The target org cannot change in the current state.'), { statusCode: 409 });
  }
  const now = new Date().toISOString();
  record.stateHistory.push({ previousState: record.status, newState: JOB_STATES.RECEIVED, timestamp: now, actor, reason, approvalId: '', orgId: '' });
  Object.assign(record, { status: JOB_STATES.RECEIVED, context: { ...record.context, selectedOrgRegistryId: selection }, orgContext: null, orgCandidates: [], metadataScope: null, plan: null, approvals: [], validation: null, deployment: null, implementation: null, diff: '', updatedAt: now });
  await save(record);
  return record;
}

async function requiredJob(jobId) {
  const record = await getJobRecord(jobId);
  if (!record) {
    const error = new Error('Job not found.');
    error.statusCode = 404;
    throw error;
  }
  return record;
}

async function save(record) {
  if (redis) {
    await redis.hset(keyFor(record.jobId), 'record', JSON.stringify(record));
    await redis.sadd('agent-jobs:index', record.jobId);
  } else {
    memoryJobs.set(record.jobId, structuredClone(record));
  }
}
