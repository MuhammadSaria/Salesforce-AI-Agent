import { nanoid } from 'nanoid';
import { JOB_STATES, assertTransition } from '../domain/jobState.js';
import { assertWorkItemTransition } from '../domain/specialistAgents.js';

export function createPostgresJobRecordStore({ pool, dispatchLeaseMs = 30000, claimantId = `dispatcher-${process.pid}`, dispatchRetryBaseMs = 1000, dispatchMaxAttempts = 5 }) {
  return {
    async create(input) {
      const record = newJobRecord(input);
      await pool.query(
        `INSERT INTO development_jobs (job_id, user_id, org_id, prompt, status, current_plan_version, record, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
        [record.jobId, record.userId, record.orgId, record.prompt, record.status, record.nextPlanVersion || 1, JSON.stringify(record), record.createdAt]
      );
      return { ...record, revision: 1 };
    },
    async get(jobId) {
      const result = await pool.query('SELECT record, revision FROM development_jobs WHERE job_id = $1', [jobId]);
      const record = result.rows[0]?.record || null;
      return record ? hydrateDispatches(pool, { ...record, revision: Number(result.rows[0].revision) }) : null;
    },
    async list() {
      const result = await pool.query('SELECT record, revision FROM development_jobs ORDER BY created_at DESC, job_id DESC');
      return Promise.all(result.rows.filter((row) => row.record).map((row) => hydrateDispatches(pool, { ...row.record, revision: Number(row.revision) })));
    },
    async update(jobId, patch) {
      return updateRecord(pool, jobId, (record) => Object.assign(record, patch));
    },
    async updateAtomically(jobId, operation) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT record FROM development_jobs WHERE job_id = $1 FOR UPDATE', [jobId]);
        if (!result.rowCount) throw notFound();
        const record = result.rows[0].record;
        const value = await operation(record);
        record.updatedAt = new Date().toISOString();
        await client.query(
          `UPDATE development_jobs
           SET status = $2, current_plan_version = $3, record = $4::jsonb, revision = revision + 1, updated_at = now()
           WHERE job_id = $1`,
          [jobId, record.status, Number(record.nextPlanVersion || record.iteration || record.plan?.planVersion || 1), JSON.stringify(record)]
        );
        await client.query('COMMIT');
        return value ?? record;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async appendConversation(jobId, entry) {
      return updateRecord(pool, jobId, (record) => {
        record.conversation = [...(record.conversation || []), conversationEntry(entry)].slice(-200);
      });
    },
    async appendAudit(jobId, event) {
      return updateRecord(pool, jobId, (record) => {
        record.audit = [...(record.audit || []), { timestamp: new Date().toISOString(), ...event }];
      });
    },
    async appendLog(jobId, level, message) {
      return updateRecord(pool, jobId, (record) => { record.logs = [...(record.logs || []), { timestamp: new Date().toISOString(), level, message: String(message).slice(0, 4000) }]; });
    },
    async appendCommand(jobId, commandLog) {
      return updateRecord(pool, jobId, (record) => { record.commands = [...(record.commands || []), { timestamp: new Date().toISOString(), ...commandLog, stdout: String(commandLog.stdout || '').slice(0, 100000), stderr: String(commandLog.stderr || '').slice(0, 20000) }]; });
    },
    async transitionWorkItem(jobId, workItemId, newStatus, details = {}) {
      return updateRecord(pool, jobId, (record) => {
        const index = (record.workItems || []).findIndex((item) => item.workItemId === workItemId);
        if (index < 0) throw Object.assign(new Error('Specialist work item not found.'), { code: 'WORK_ITEM_NOT_FOUND', statusCode: 404 });
        assertWorkItemTransition(record.workItems[index].status, newStatus);
        record.workItems[index] = { ...record.workItems[index], ...details, status: newStatus, updatedAt: new Date().toISOString() };
      });
    },
    async claimFileOwnership(jobId, path, workItemId, owningAgent, baselineHash) {
      return updateRecord(pool, jobId, (record) => {
        const item = (record.fileOwnership || []).find((entry) => entry.path === path);
        if (!item || item.workItemId !== workItemId || item.owningAgent !== owningAgent || item.lockStatus === 'LOCKED') throw Object.assign(new Error('File ownership conflict.'), { code: 'FILE_OWNERSHIP_CONFLICT', statusCode: 409 });
        Object.assign(item, { lockStatus: 'LOCKED', baselineHash, currentHash: '', updatedAt: new Date().toISOString() });
      });
    },
    async releaseFileOwnership(jobId, path, workItemId, currentHash) {
      return updateRecord(pool, jobId, (record) => {
        const item = (record.fileOwnership || []).find((entry) => entry.path === path && entry.workItemId === workItemId && entry.lockStatus === 'LOCKED');
        if (!item) throw Object.assign(new Error('File ownership conflict.'), { code: 'FILE_OWNERSHIP_CONFLICT', statusCode: 409 });
        Object.assign(item, { lockStatus: 'RELEASED', currentHash, updatedAt: new Date().toISOString() });
      });
    },
    async acquireComponentLocks({ jobId, componentKeys, leaseMilliseconds, lockToken }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const componentKey of componentKeys) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [componentKey]);
        }
        const existing = await client.query(
          `SELECT component_key, job_id, lease_expires_at > now() AS active
           FROM component_locks
           WHERE component_key = ANY($1::text[])
           FOR UPDATE`,
          [componentKeys]
        );
        if (existing.rows.some((row) => row.active && row.job_id !== jobId)) {
          throw Object.assign(new Error('One or more approved components are currently locked.'), { code: 'COMPONENT_LOCKED', statusCode: 409 });
        }
        for (const componentKey of componentKeys) {
          await client.query(
            `INSERT INTO component_locks (lock_id, job_id, component_key, lease_expires_at, released_at)
             VALUES ($1, $2, $3, now() + ($4::int * interval '1 millisecond'), NULL)
             ON CONFLICT (component_key) DO UPDATE
             SET lock_id = EXCLUDED.lock_id,
                 job_id = EXCLUDED.job_id,
                 lease_expires_at = EXCLUDED.lease_expires_at,
                 released_at = NULL,
                 updated_at = now()`,
            [lockToken, jobId, componentKey, leaseMilliseconds]
          );
        }
        const expiry = await client.query('SELECT now() + ($1::int * interval \'1 millisecond\') AS lease_expires_at', [leaseMilliseconds]);
        await client.query('COMMIT');
        return { jobId, componentKeys, lockToken, leaseExpiresAt: expiry.rows[0].lease_expires_at.toISOString() };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async renewComponentLocks({ jobId, componentKeys, leaseMilliseconds, lockToken }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const componentKey of componentKeys) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [componentKey]);
        }
        const renewed = await client.query(
          `UPDATE component_locks
           SET lease_expires_at = now() + ($3::int * interval '1 millisecond'), updated_at = now()
           WHERE job_id = $1
             AND component_key = ANY($2::text[])
             AND lock_id = $4
             AND lease_expires_at > now()
           RETURNING component_key, lease_expires_at`,
          [jobId, componentKeys, leaseMilliseconds, lockToken]
        );
        if (renewed.rowCount !== componentKeys.length) {
          throw Object.assign(new Error('Component lock ownership was lost.'), { code: 'COMPONENT_LOCK_LOST', statusCode: 409 });
        }
        await client.query('COMMIT');
        return { jobId, componentKeys, lockToken, leaseExpiresAt: renewed.rows[0].lease_expires_at.toISOString() };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async releaseComponentLocks({ jobId, componentKeys, lockToken }) {
      await pool.query(
        `DELETE FROM component_locks
         WHERE job_id = $1 AND component_key = ANY($2::text[]) AND lock_id = $3`,
        [jobId, componentKeys, lockToken]
      );
      return { jobId, componentKeys };
    },
    async assertComponentLocksOwned({ jobId, componentKeys, lockToken }) {
      await assertPostgresLocks(pool, { jobId, componentKeys, lockToken });
      return { jobId, componentKeys, lockToken };
    },
    async updateWithComponentLocks({ jobId, componentKeys, lockToken }, operation) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await assertPostgresLocks(client, { jobId, componentKeys, lockToken, forUpdate: true });
        const result = await client.query('SELECT record FROM development_jobs WHERE job_id = $1 FOR UPDATE', [jobId]);
        if (!result.rowCount) throw notFound();
        const record = result.rows[0].record;
        const value = await operation(record);
        record.updatedAt = new Date().toISOString();
        await client.query(
          `UPDATE development_jobs
           SET status = $2, current_plan_version = $3, record = $4::jsonb, revision = revision + 1, updated_at = now()
           WHERE job_id = $1`,
          [jobId, record.status, Number(record.nextPlanVersion || record.iteration || record.plan?.planVersion || 1), JSON.stringify(record)]
        );
        await client.query('COMMIT');
        return value ?? record;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async invalidateForOrgChange(jobId, selection, actor) { return invalidateRecord(pool, jobId, selection, actor, true); },
    async invalidateForPlanChange(jobId, actor) {
      const current = await this.get(jobId);
      return invalidateRecord(pool, jobId, current?.orgContext?.orgRegistryId || '', actor, false);
    },
    async transition(jobId, newState, details = {}) {
      return updateRecord(pool, jobId, (record) => {
        assertTransition(record.status, newState, record);
        const now = new Date().toISOString();
        record.stateHistory.push({
          previousState: record.status,
          newState,
          timestamp: now,
          actor: details.actor || 'system',
          reason: details.reason || '',
          approvalId: details.approvalId || '',
          orgId: record.orgContext?.expectedOrgId || ''
        });
        record.status = newState;
        if (details.error) record.error = details.error;
      });
    },
    async createDispatch(dispatch) {
      await pool.query(
        `INSERT INTO job_dispatches (dispatch_key, job_id, action, actor_id, status, attempts, last_error, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, 0, '', now())
         ON CONFLICT (dispatch_key) DO NOTHING`,
        [dispatch.dispatchKey, dispatch.jobId, dispatch.action, dispatch.actor || dispatch.actorId || 'system', dispatch.status || 'PENDING']
      );
      return dispatch;
    },
    async claimDispatch(dispatchKey) {
      const result = await pool.query(
        `UPDATE job_dispatches
         SET status = 'DISPATCHING',
             attempts = attempts + 1,
             claimed_at = now(),
             lease_expires_at = now() + ($2::int * interval '1 millisecond'),
             claimant_id = $3,
             updated_at = now()
         WHERE dispatch_key = $1
           AND attempts < $4
           AND ((status = 'PENDING') OR (status = 'RETRYABLE' AND next_attempt_at <= now()) OR (status = 'DISPATCHING' AND lease_expires_at <= now()))
         RETURNING dispatch_key, job_id, action, actor_id, status, attempts, last_error, claimed_at, lease_expires_at, claimant_id, created_at, updated_at, dispatched_at, next_attempt_at, terminal_at, terminal_reason`,
        [dispatchKey, dispatchLeaseMs, claimantId, dispatchMaxAttempts]
      );
      if (!result.rowCount) return null;
      const dispatch = dispatchFromRow(result.rows[0]);
      return { job: await this.get(dispatch.jobId), dispatch };
    },
    async claimNextDispatch() {
      const result = await pool.query(
        `WITH next_dispatch AS (
           SELECT dispatch_key
           FROM job_dispatches
           WHERE attempts < $3
             AND ((status = 'PENDING') OR (status = 'RETRYABLE' AND next_attempt_at <= now()) OR (status = 'DISPATCHING' AND lease_expires_at <= now()))
           ORDER BY created_at, dispatch_key
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE job_dispatches d
         SET status = 'DISPATCHING',
             attempts = attempts + 1,
             claimed_at = now(),
             lease_expires_at = now() + ($1::int * interval '1 millisecond'),
             claimant_id = $2,
             updated_at = now()
         FROM next_dispatch
         WHERE d.dispatch_key = next_dispatch.dispatch_key
         RETURNING d.dispatch_key, d.job_id, d.action, d.actor_id, d.status, d.attempts, d.last_error, d.claimed_at, d.lease_expires_at, d.claimant_id, d.created_at, d.updated_at, d.dispatched_at, d.next_attempt_at, d.terminal_at, d.terminal_reason`,
        [dispatchLeaseMs, claimantId, dispatchMaxAttempts]
      );
      if (!result.rowCount) return null;
      return dispatchFromRow(result.rows[0]);
    },
    async markDispatchDelivered(dispatchKey) {
      await pool.query(
        `UPDATE job_dispatches
         SET status = 'DELIVERED',
             dispatched_at = now(),
             claimed_at = NULL,
             lease_expires_at = NULL,
             claimant_id = '',
             updated_at = now()
         WHERE dispatch_key = $1`,
        [dispatchKey]
      );
    },
    async markDispatchRetryable(dispatchKey, error) {
      await pool.query(
        `UPDATE job_dispatches
         SET status = CASE WHEN attempts >= $3 THEN 'TERMINAL' ELSE 'RETRYABLE' END,
             last_error = $2,
             next_attempt_at = CASE WHEN attempts >= $3 THEN next_attempt_at ELSE now() + (($4::int * power(2, greatest(attempts - 1, 0)))::text || ' milliseconds')::interval END,
             terminal_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END,
             terminal_reason = CASE WHEN attempts >= $3 THEN 'MAX_ATTEMPTS_EXCEEDED' ELSE '' END,
             claimed_at = NULL,
             lease_expires_at = NULL,
             claimant_id = '',
             updated_at = now()
         WHERE dispatch_key = $1`,
        [dispatchKey, sanitizeDispatchError(error), dispatchMaxAttempts, dispatchRetryBaseMs]
      );
    },
    async listClaimableDispatches() {
      const result = await pool.query(
        `SELECT dispatch_key, job_id, action, actor_id, status, attempts, last_error, claimed_at, lease_expires_at, claimant_id, created_at, updated_at, dispatched_at, next_attempt_at, terminal_at, terminal_reason
         FROM job_dispatches
         WHERE attempts < $1 AND ((status = 'PENDING') OR (status = 'RETRYABLE' AND next_attempt_at <= now()) OR (status = 'DISPATCHING' AND lease_expires_at <= now()))
         ORDER BY created_at, dispatch_key`
        , [dispatchMaxAttempts]
      );
      return result.rows.map((row) => ({ jobId: row.job_id, dispatch: dispatchFromRow(row) }));
    },
    async savePlanWithCompareAndSet(jobId, expectedRevision, planPatch) {
      return updateRecordWithRevision(pool, jobId, expectedRevision, (record) => Object.assign(record, planPatch));
    },
    async appendConversationAtomically(jobId, expectedRevision, operation) {
      if (typeof operation !== 'function') return this.appendConversation(jobId, expectedRevision);
      return atomicMutationWithDispatch(pool, jobId, expectedRevision, operation);
    },
    async approveImplementationAtomically(jobId, expectedRevision, operation) {
      return atomicMutationWithDispatch(pool, jobId, expectedRevision, operation);
    }
  };
}

async function atomicMutationWithDispatch(pool, jobId, expectedRevision, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query('SELECT record, revision FROM development_jobs WHERE job_id = $1 FOR UPDATE', [jobId]);
    if (!selected.rowCount) throw notFound();
    const revision = Number(selected.rows[0].revision);
    if (revision !== Number(expectedRevision)) throw Object.assign(new Error('Job revision is stale.'), { statusCode: 409, code: 'STALE_REVISION' });
    const record = selected.rows[0].record;
    const outcome = await operation(record);
    if (!outcome || typeof outcome !== 'object' || !outcome.dispatch || !outcome.result) throw Object.assign(new Error('Atomic mutation must provide one durable dispatch.'), { code: 'ATOMIC_MUTATION_INVALID' });
    const dispatch = outcome.dispatch;
    const allowed = ['dispatchKey', 'jobId', 'action', 'actor', 'actorId', 'status', 'attempts', 'createdAt', 'updatedAt'];
    if (Object.keys(dispatch).some((key) => !allowed.includes(key)) || dispatch.jobId !== jobId || !dispatch.dispatchKey || !dispatch.action) {
      throw Object.assign(new Error('Atomic dispatch is invalid.'), { code: 'ATOMIC_DISPATCH_INVALID' });
    }
    const inserted = await client.query(
      `INSERT INTO job_dispatches (dispatch_key, job_id, action, actor_id, status, attempts, last_error, next_attempt_at)
       VALUES ($1, $2, $3, $4, 'PENDING', 0, '', now())
       ON CONFLICT (dispatch_key) DO NOTHING RETURNING dispatch_key`,
      [dispatch.dispatchKey, jobId, dispatch.action, dispatch.actor || dispatch.actorId || 'system']
    );
    if (!inserted.rowCount) throw Object.assign(new Error('Atomic dispatch conflicts with existing work.'), { statusCode: 409, code: 'DISPATCH_CONFLICT' });
    record.updatedAt = new Date().toISOString();
    await client.query(
      `UPDATE development_jobs SET status=$2, current_plan_version=$3, record=$4::jsonb, revision=revision+1, updated_at=now() WHERE job_id=$1`,
      [jobId, record.status, Number(record.nextPlanVersion || record.iteration || record.plan?.planVersion || 1), JSON.stringify(record)]
    );
    await client.query('COMMIT');
    return outcome.result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function updateRecord(pool, jobId, mutate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT record FROM development_jobs WHERE job_id = $1 FOR UPDATE', [jobId]);
    if (!result.rowCount) throw notFound();
    const record = result.rows[0].record;
    await mutate(record);
    record.updatedAt = new Date().toISOString();
    await client.query(
      `UPDATE development_jobs
       SET status = $2, current_plan_version = $3, record = $4::jsonb, revision = revision + 1, updated_at = now()
       WHERE job_id = $1`,
      [jobId, record.status, Number(record.nextPlanVersion || record.iteration || record.plan?.planVersion || 1), JSON.stringify(record)]
    );
    await client.query('COMMIT');
    return record;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateRecordWithRevision(pool, jobId, expectedRevision, mutate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT record, revision FROM development_jobs WHERE job_id = $1 FOR UPDATE', [jobId]);
    if (!result.rowCount) throw notFound();
    if (Number(result.rows[0].revision) !== Number(expectedRevision)) {
      throw Object.assign(new Error('Job revision is stale.'), { statusCode: 409, code: 'STALE_REVISION' });
    }
    const record = result.rows[0].record;
    await mutate(record);
    record.updatedAt = new Date().toISOString();
    await client.query(
      `UPDATE development_jobs
       SET status = $2, current_plan_version = $3, record = $4::jsonb, revision = revision + 1, updated_at = now()
       WHERE job_id = $1`,
      [jobId, record.status, Number(record.nextPlanVersion || record.iteration || record.plan?.planVersion || 1), JSON.stringify(record)]
    );
    await client.query('COMMIT');
    return record;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function invalidateRecord(pool, jobId, selection, actor, orgChanged) {
  return updateRecord(pool, jobId, (record) => {
    if ([JOB_STATES.CANCELLED, JOB_STATES.DEPLOYING].includes(record.status)) throw Object.assign(new Error('This job cannot be revised in its current state.'), { statusCode: 409 });
    const now = new Date().toISOString();
    const currentPlanVersion = Number(record.plan?.planVersion || record.nextPlanVersion || 0);
    record.revisions = [...(record.revisions || []), ...(record.plan ? [{ revisionNumber: currentPlanVersion, invalidatedAt: now, invalidatedBy: actor, plan: record.plan, approvals: record.approvals, orgContext: record.orgContext, sourceValidation: record.sourceValidation, implementationBaseline: record.implementationBaseline, correctionAttempt: record.correctionAttempt, correctionHistory: record.correctionHistory }] : [])];
    record.stateHistory.push({ previousState: record.status, newState: JOB_STATES.RECEIVED, timestamp: now, actor, reason: orgChanged ? 'Target org changed; artifacts invalidated.' : 'Requirements changed; artifacts invalidated.', approvalId: '', orgId: '' });
    Object.assign(record, { status: JOB_STATES.RECEIVED, context: { ...record.context, selectedOrgRegistryId: selection }, orgContext: null, metadataScope: null, plan: null, nextPlanVersion: Math.max(1, currentPlanVersion + 1), iteration: Math.max(1, currentPlanVersion + 1), orchestration: null, workItems: [], specialistMessages: [], specialistResults: {}, fileOwnership: [], revisionContext: null, approvals: [], sourceValidation: null, implementationBaseline: null, correctionAttempt: 0, correctionReservation: null, correctionHistory: [], validation: null, dataPreview: null, deployment: null, implementation: null, diff: '', error: '' });
  });
}

async function assertPostgresLocks(db, { jobId, componentKeys, lockToken, forUpdate = false }) {
  const result = await db.query(
    `SELECT component_key
     FROM component_locks
     WHERE job_id = $1
       AND component_key = ANY($2::text[])
       AND lock_id = $3
       AND lease_expires_at > now()
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [jobId, componentKeys, lockToken]
  );
  if (result.rowCount !== componentKeys.length) {
    throw Object.assign(new Error('Component lock ownership was lost.'), { code: 'COMPONENT_LOCK_LOST', statusCode: 409 });
  }
}

function newJobRecord(input) {
  const now = new Date().toISOString();
  return {
    jobId: input.jobId,
    jiraIssueKey: input.jiraIssueKey || '',
    source: input.source || 'manual',
    status: JOB_STATES.RECEIVED,
    prompt: input.prompt || '',
    orgId: input.orgId || '',
    userId: input.userId || '',
    context: input.context || {},
    orgContext: input.orgContext || null,
    orgCandidates: [],
    orgRoutingEvidence: [],
    jira: input.jira || null,
    jiraSync: null,
    pendingRevision: false,
    followUpRequired: false,
    conversation: [],
    clarifications: [],
    dispatches: [],
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
    dataPreview: null,
    deployment: null,
    sourceValidation: null,
    implementationBaseline: null,
    correctionAttempt: 0,
    correctionReservation: null,
    correctionHistory: [],
    diff: '',
    logs: [{ timestamp: now, level: 'info', message: 'Job received.' }],
    commands: [],
    stateHistory: [{ previousState: null, newState: JOB_STATES.RECEIVED, timestamp: now, actor: input.userId || 'system', reason: 'Job created', approvalId: '', orgId: '' }],
    audit: [],
    error: '',
    createdAt: now,
    updatedAt: now
  };
}

function conversationEntry(entry) {
  return {
    conversationId: entry.conversationId || nanoid(),
    role: entry.role || 'user',
    kind: entry.kind || 'message',
    source: entry.source || 'salesforce-ui',
    text: String(entry.text || '').slice(0, 4000),
    actor: String(entry.actor || ''),
    timestamp: entry.timestamp || new Date().toISOString(),
    responseToMessageId: entry.responseToMessageId || '',
    ambiguityId: entry.ambiguityId || '',
    responseToInspectionHash: entry.responseToInspectionHash || '',
    responseToPlanVersion: entry.responseToPlanVersion || 0
  };
}

function notFound() {
  const error = new Error('Job not found.');
  error.statusCode = 404;
  return error;
}

async function hydrateDispatches(pool, record) {
  const result = await pool.query(
    `SELECT dispatch_key, job_id, action, actor_id, status, attempts, last_error, claimed_at, lease_expires_at, claimant_id, created_at, updated_at, dispatched_at, next_attempt_at, terminal_at, terminal_reason
     FROM job_dispatches
     WHERE job_id = $1
     ORDER BY created_at, dispatch_key`,
    [record.jobId]
  );
  return { ...record, dispatches: result.rows.map(dispatchFromRow) };
}

function dispatchFromRow(row) {
  return {
    dispatchKey: row.dispatch_key,
    jobId: row.job_id,
    action: row.action,
    actor: row.actor_id,
    actorId: row.actor_id,
    status: row.status,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || '',
    claimedAt: row.claimed_at?.toISOString() || '',
    leaseExpiresAt: row.lease_expires_at?.toISOString() || '',
    claimantId: row.claimant_id || '',
    createdAt: row.created_at?.toISOString() || '',
    updatedAt: row.updated_at?.toISOString() || '',
    dispatchedAt: row.dispatched_at?.toISOString() || ''
    ,nextAttemptAt: row.next_attempt_at?.toISOString() || '',
    terminalAt: row.terminal_at?.toISOString() || '',
    terminalReason: row.terminal_reason || ''
  };
}

function sanitizeDispatchError(error) {
  return String(error?.message || error || 'Queue delivery failed.').replace(/\s+/g, ' ').slice(0, 500);
}
