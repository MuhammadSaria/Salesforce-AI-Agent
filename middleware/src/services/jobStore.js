import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import { redis } from '../queue/connection.js';
import { assertTransition, JOB_STATES } from '../domain/jobState.js';
import { config } from '../config.js';
import { assertWorkItemTransition, selectAffectedSpecialistAgents } from '../domain/specialistAgents.js';

const memoryJobs = new Map();
const localLocks = new Map();
const keyFor = (jobId) => `agent-job:${jobId}`;
const indexKey = 'agent-jobs:index';
const lockKeyFor = (jobId) => `agent-job-lock:${jobId}`;

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
    orgRoutingEvidence: [],
    jira: input.jira || null,
    jiraSync: null,
    pendingRevision: false,
    followUpRequired: false,
    conversation: [],
    metadataScope: null,
    plan: null,
    iteration: 1,
    orchestration: null,
    workItems: [],
    specialistMessages: [],
    fileOwnership: [],
    revisionContext: null,
    nextPlanVersion: 1,
    revisions: [],
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
  assertSafeJobId(jobId);
  let raw = null;
  let loadedFromRedis = false;
  if (redis) {
    try {
      raw = await redis.hget(keyFor(jobId), 'record');
      loadedFromRedis = Boolean(raw);
    } catch {
      raw = null;
    }
  } else {
    raw = memoryJobs.get(jobId);
  }
  if (!raw) raw = await readSnapshot(jobId);
  if (!raw) return null;
  const record = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
  if (loadedFromRedis) await ensureSnapshot(record);
  return record;
}

export async function listJobRecords() {
  const ids = new Set(memoryJobs.keys());
  if (redis) {
    try {
      for (const id of await redis.smembers(indexKey)) ids.add(id);
    } catch {
      // Disk snapshots remain available while Redis is restarting.
    }
  }
  for (const id of await listSnapshotIds()) ids.add(id);
  return (await Promise.all([...ids].map(getJobRecord))).filter(Boolean);
}

export async function updateJob(jobId, patch) {
  return withJobLock(jobId, async () => {
    const record = await requiredJob(jobId);
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    await save(record);
    return record;
  });
}

export async function transitionJob(jobId, newState, details = {}) {
  return withJobLock(jobId, async () => {
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
    if (details.error) {
      record.error = details.error;
    } else if (![JOB_STATES.FAILED, JOB_STATES.VALIDATION_FAILED, JOB_STATES.ORG_VERIFICATION_FAILED].includes(newState)) {
      record.error = '';
    }
    await save(record);
    return record;
  });
}

export async function appendLog(jobId, level, message) {
  await withJobLock(jobId, async () => {
    const record = await requiredJob(jobId);
    record.logs.push({ timestamp: new Date().toISOString(), level, message: String(message).slice(0, 4000) });
    await save(record);
  });
}

export async function appendCommand(jobId, commandLog) {
  await withJobLock(jobId, async () => {
    const record = await requiredJob(jobId);
    record.commands.push({
      timestamp: new Date().toISOString(),
      ...commandLog,
      stdout: String(commandLog.stdout || '').slice(0, 100000),
      stderr: String(commandLog.stderr || '').slice(0, 20000)
    });
    await save(record);
  });
}

export async function appendConversation(jobId, entry) {
  await withJobLock(jobId, async () => {
    const record = await requiredJob(jobId);
    const conversation = [...(record.conversation || []), {
      conversationId: entry.conversationId || nanoid(),
      role: entry.role || 'user',
      kind: entry.kind || 'message',
      source: entry.source || 'salesforce-ui',
      text: String(entry.text || '').slice(0, 4000),
      actor: String(entry.actor || ''),
      timestamp: entry.timestamp || new Date().toISOString(),
      responseToMessageId: entry.responseToMessageId || ''
    }];
    record.conversation = conversation.slice(-200);
    await save(record);
  });
}

export async function appendAudit(jobId, event) {
  await withJobLock(jobId, async () => {
    const record = await requiredJob(jobId);
    record.audit.push({ timestamp: new Date().toISOString(), ...event });
    await save(record);
  });
}

export async function transitionWorkItem(jobId, workItemId, newStatus, details = {}) {
  return withJobLock(jobId, async () => {
    const record = await requiredJob(jobId);
    const index = (record.workItems || []).findIndex((item) => item.workItemId === workItemId);
    if (index < 0) throw Object.assign(new Error('Specialist work item not found.'), { statusCode: 404, code: 'WORK_ITEM_NOT_FOUND' });
    const current = record.workItems[index];
    assertWorkItemTransition(current.status, newStatus);
    const now = new Date().toISOString();
    record.workItems[index] = { ...current, ...details, status: newStatus, updatedAt: now };
    record.updatedAt = now;
    await save(record);
    return record.workItems[index];
  });
}

export async function appendSpecialistMessage(jobId, message) {
  return withJobLock(jobId, async () => {
    const record = await requiredJob(jobId);
    record.specialistMessages = [...(record.specialistMessages || []), message].slice(-1000);
    record.updatedAt = new Date().toISOString();
    await save(record);
    return message;
  });
}

export async function claimFileOwnership(jobId, path, workItemId, owningAgent, baselineHash) {
  return withJobLock(jobId, async () => {
    const record = await requiredJob(jobId);
    const ownership = (record.fileOwnership || []).find((item) => item.path === path);
    if (!ownership) throw Object.assign(new Error(`No approved file ownership exists for ${path}.`), { code: 'FILE_OWNERSHIP_MISSING' });
    if (ownership.workItemId !== workItemId || ownership.owningAgent !== owningAgent) throw Object.assign(new Error(`File ownership mismatch for ${path}.`), { code: 'FILE_OWNERSHIP_CONFLICT' });
    if (ownership.lockStatus === 'LOCKED') throw Object.assign(new Error(`${path} is already locked by a specialist agent.`), { statusCode: 409, code: 'FILE_ALREADY_LOCKED' });
    Object.assign(ownership, { lockStatus: 'LOCKED', baselineHash, currentHash: '', updatedAt: new Date().toISOString() });
    record.updatedAt = ownership.updatedAt;
    await save(record);
    return ownership;
  });
}

export async function releaseFileOwnership(jobId, path, workItemId, currentHash) {
  return withJobLock(jobId, async () => {
    const record = await requiredJob(jobId);
    const ownership = (record.fileOwnership || []).find((item) => item.path === path);
    if (!ownership || ownership.workItemId !== workItemId || ownership.lockStatus !== 'LOCKED') throw Object.assign(new Error(`Active file ownership was not found for ${path}.`), { code: 'FILE_OWNERSHIP_CONFLICT' });
    Object.assign(ownership, { lockStatus: 'RELEASED', currentHash, updatedAt: new Date().toISOString() });
    record.updatedAt = ownership.updatedAt;
    await save(record);
    return ownership;
  });
}

export async function invalidateForOrgChange(jobId, selection, actor) {
  return invalidate(jobId, selection, actor, 'Target org changed; plan, approvals, validation, hashes, and deployment package invalidated.', { orgChanged: true });
}

export async function invalidateForPlanChange(jobId, actor, options = {}) {
  const record = await requiredJob(jobId);
  return invalidate(jobId, record.orgContext?.orgRegistryId || record.context?.selectedOrgRegistryId || '', actor, 'Requirements changed; plan, approvals, validation, hashes, and deployment package invalidated.', options);
}

async function invalidate(jobId, selection, actor, reason, options = {}) {
  return withJobLock(jobId, async () => {
    const record = await requiredJob(jobId);
    if ([JOB_STATES.CANCELLED, JOB_STATES.DEPLOYING].includes(record.status)) {
      throw Object.assign(new Error('This job cannot be revised in its current state.'), { statusCode: 409 });
    }
    const now = new Date().toISOString();
    const currentPlanVersion = Number(record.plan?.planVersion || record.nextPlanVersion || 0);
    const revisions = [...(record.revisions || [])];
    if (record.plan || record.implementation || record.validation || record.approvals?.length) {
      revisions.push({
        revisionNumber: currentPlanVersion,
        invalidatedAt: now,
        invalidatedBy: actor,
        reason,
        orgContext: record.orgContext,
        metadataScope: record.metadataScope,
        plan: record.plan,
        approvals: record.approvals,
        implementation: record.implementation,
        validation: record.validation,
        deployment: record.deployment,
        diff: record.diff,
        iteration: record.iteration,
        orchestration: record.orchestration,
        workItems: record.workItems,
        specialistMessages: record.specialistMessages,
        fileOwnership: record.fileOwnership
      });
    }
    const affectedAgentIds = options.orgChanged
      ? (record.workItems || []).map((item) => item.assignedSpecialistAgent)
      : (options.instruction
          ? selectAffectedSpecialistAgents(options.instruction)
          : (record.workItems || []).map((item) => item.assignedSpecialistAgent));
    const affected = new Set(affectedAgentIds);
    const preservedWorkItems = options.orgChanged ? [] : (record.workItems || []).filter((item) => item.status === 'COMPLETED' && !affected.has(item.assignedSpecialistAgent));
    const revisionContext = options.orgChanged ? null : {
      previousPlanVersion: record.plan?.planVersion || currentPlanVersion,
      previousMaterialChangeHash: record.plan?.materialChangeHash || '',
      previousApprovals: record.approvals || [],
      affectedAgentIds,
      preservedWorkItems
    };
    record.stateHistory.push({ previousState: record.status, newState: JOB_STATES.RECEIVED, timestamp: now, actor, reason, approvalId: '', orgId: '' });
    Object.assign(record, { status: JOB_STATES.RECEIVED, context: { ...record.context, selectedOrgRegistryId: selection }, orgContext: null, orgCandidates: [], orgRoutingEvidence: [], metadataScope: null, plan: null, nextPlanVersion: Math.max(1, currentPlanVersion + 1), iteration: Math.max(1, currentPlanVersion + 1), orchestration: null, workItems: preservedWorkItems, specialistMessages: [], fileOwnership: [], revisionContext, revisions, approvals: [], validation: null, deployment: null, implementation: null, diff: '', pendingRevision: false, followUpRequired: false, error: '', updatedAt: now });
    await save(record);
    return record;
  });
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
  await writeSnapshot(record);
  if (redis) {
    try {
      await redis.hset(keyFor(record.jobId), 'record', JSON.stringify(record));
      await redis.sadd(indexKey, record.jobId);
    } catch {
      memoryJobs.set(record.jobId, structuredClone(record));
    }
  } else {
    memoryJobs.set(record.jobId, structuredClone(record));
  }
}

async function withJobLock(jobId, operation) {
  assertSafeJobId(jobId);
  const previous = localLocks.get(jobId) || Promise.resolve();
  let releaseLocal;
  const current = new Promise((resolveLock) => { releaseLocal = resolveLock; });
  localLocks.set(jobId, current);
  await previous;

  let lockToken = '';
  try {
    lockToken = await acquireRedisLock(jobId);
    return await operation();
  } finally {
    if (lockToken) await releaseRedisLock(jobId, lockToken);
    releaseLocal();
    if (localLocks.get(jobId) === current) localLocks.delete(jobId);
  }
}

async function acquireRedisLock(jobId) {
  if (!redis) return '';
  const token = randomUUID();
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const acquired = await redis.set(lockKeyFor(jobId), token, 'PX', 15000, 'NX');
      if (acquired === 'OK') return token;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  } catch {
    return '';
  }
  throw Object.assign(new Error('Timed out waiting for the job mutation lock.'), { statusCode: 409 });
}

async function releaseRedisLock(jobId, token) {
  try {
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKeyFor(jobId), token);
  } catch {
    // The lock expires automatically if Redis becomes unavailable.
  }
}

function assertSafeJobId(jobId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(jobId))) {
    throw Object.assign(new Error('Invalid job ID.'), { statusCode: 400 });
  }
}

function snapshotPath(jobId) {
  assertSafeJobId(jobId);
  return resolve(config.workspaceRoot, 'jobs', jobId, 'record.json');
}

async function writeSnapshot(record) {
  const path = snapshotPath(record.jobId);
  const directory = resolve(path, '..');
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

async function ensureSnapshot(record) {
  try {
    await access(snapshotPath(record.jobId));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeSnapshot(record);
  }
}

async function readSnapshot(jobId) {
  try {
    return await readFile(snapshotPath(jobId), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function listSnapshotIds() {
  try {
    const entries = await readdir(resolve(config.workspaceRoot, 'jobs'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
