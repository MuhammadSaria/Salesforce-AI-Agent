import { nanoid } from 'nanoid';
import { JOB_STATES, assertTransition } from '../domain/jobState.js';

export function createPostgresJobRecordStore({ pool, dispatchLeaseMs = 30000, claimantId = `dispatcher-${process.pid}` }) {
  return {
    async create(input) {
      const record = newJobRecord(input);
      await pool.query(
        `INSERT INTO development_jobs (job_id, user_id, org_id, prompt, status, current_plan_version, record, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
        [record.jobId, record.userId, record.orgId, record.prompt, record.status, record.nextPlanVersion || 1, JSON.stringify(record), record.createdAt]
      );
      return record;
    },
    async get(jobId) {
      const result = await pool.query('SELECT record FROM development_jobs WHERE job_id = $1', [jobId]);
      const record = result.rows[0]?.record || null;
      return record ? hydrateDispatches(pool, record) : null;
    },
    async list() {
      const result = await pool.query('SELECT record FROM development_jobs ORDER BY created_at DESC, job_id DESC');
      return Promise.all(result.rows.map((row) => row.record).filter(Boolean).map((record) => hydrateDispatches(pool, record)));
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
        `INSERT INTO job_dispatches (dispatch_key, job_id, action, actor_id, status, attempts, last_error)
         VALUES ($1, $2, $3, $4, $5, 0, '')
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
           AND (status IN ('PENDING', 'RETRYABLE') OR (status = 'DISPATCHING' AND lease_expires_at <= now()))
         RETURNING dispatch_key, job_id, action, actor_id, status, attempts, last_error, claimed_at, lease_expires_at, claimant_id, created_at, updated_at, dispatched_at`,
        [dispatchKey, dispatchLeaseMs, claimantId]
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
           WHERE status IN ('PENDING', 'RETRYABLE') OR (status = 'DISPATCHING' AND lease_expires_at <= now())
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
         RETURNING d.dispatch_key, d.job_id, d.action, d.actor_id, d.status, d.attempts, d.last_error, d.claimed_at, d.lease_expires_at, d.claimant_id, d.created_at, d.updated_at, d.dispatched_at`,
        [dispatchLeaseMs, claimantId]
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
         SET status = 'RETRYABLE',
             last_error = $2,
             claimed_at = NULL,
             lease_expires_at = NULL,
             claimant_id = '',
             updated_at = now()
         WHERE dispatch_key = $1`,
        [dispatchKey, sanitizeDispatchError(error)]
      );
    },
    async listClaimableDispatches() {
      const result = await pool.query(
        `SELECT dispatch_key, job_id, action, actor_id, status, attempts, last_error, claimed_at, lease_expires_at, claimant_id, created_at, updated_at, dispatched_at
         FROM job_dispatches
         WHERE status IN ('PENDING', 'RETRYABLE') OR (status = 'DISPATCHING' AND lease_expires_at <= now())
         ORDER BY created_at, dispatch_key`
      );
      return result.rows.map((row) => ({ jobId: row.job_id, dispatch: dispatchFromRow(row) }));
    },
    async savePlanWithCompareAndSet(jobId, expectedRevision, planPatch) {
      return updateRecordWithRevision(pool, jobId, expectedRevision, (record) => Object.assign(record, planPatch));
    },
    async appendConversationAtomically(jobId, entry) {
      return this.appendConversation(jobId, entry);
    },
    async approveImplementationAtomically(jobId, operation) {
      return this.updateAtomically(jobId, operation);
    }
  };
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
    `SELECT dispatch_key, job_id, action, actor_id, status, attempts, last_error, claimed_at, lease_expires_at, claimant_id, created_at, updated_at, dispatched_at
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
  };
}

function sanitizeDispatchError(error) {
  return String(error?.message || error || 'Queue delivery failed.').replace(/\s+/g, ' ').slice(0, 500);
}
