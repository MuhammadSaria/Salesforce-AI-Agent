import { DEVELOPMENT_JOB_STATES, assertDevelopmentTransition } from '../domain/developmentJob.js';

export function createJobRepository({ pool }) {
  return repositoryFor(pool, { ownsTransactions: true });
}

function repositoryFor(db, { ownsTransactions }) {
  async function runInTransaction(work) {
    if (!ownsTransactions) return work(db);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function withTransaction(work) {
    if (!ownsTransactions) return work(repositoryFor(db, { ownsTransactions: false }));
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const value = await work(repositoryFor(client, { ownsTransactions: false }));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    withTransaction,
    async createJob(input) {
      const now = new Date();
      await db.query(
        `INSERT INTO development_jobs (job_id, user_id, org_id, prompt, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [input.jobId, input.userId, input.orgId, input.prompt, input.status || DEVELOPMENT_JOB_STATES.RECEIVED, now]
      );
    },
    async getJob(jobId) {
      return hydrateJob(db, jobId, { ownsTransactions });
    },
    async listJobs() {
      return runReadOnlySnapshot(async (client) => {
        const result = await client.query('SELECT job_id FROM development_jobs ORDER BY created_at DESC, job_id DESC');
        return Promise.all(result.rows.map((row) => hydrateJob(client, row.job_id, { ownsTransactions: false })));
      }, { db, ownsTransactions });
    },
    async appendMessage(jobId, message) {
      await db.query(
        `INSERT INTO job_messages (message_id, job_id, role, kind, text, body)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [message.messageId, jobId, message.role, message.kind, message.text, JSON.stringify(message.body || {})]
      );
    },
    async savePlan(jobId, plan) {
      await runInTransaction(async (client) => {
        await client.query(
          `INSERT INTO job_plans (job_id, version, plan_hash, scope_hash, body)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [jobId, plan.version, plan.planHash, plan.scopeHash, JSON.stringify(plan.body || {})]
        );
        await client.query(
          `UPDATE development_jobs
           SET current_plan_version = $2, status = $3, updated_at = now()
           WHERE job_id = $1`,
          [jobId, plan.version, DEVELOPMENT_JOB_STATES.AWAITING_IMPLEMENTATION_APPROVAL]
        );
      });
    },
    async appendApproval(jobId, approval) {
      await db.query(
        `INSERT INTO job_approvals (approval_id, job_id, approval_type, decision, actor_id, plan_hash, scope_hash, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          approval.approvalId,
          jobId,
          approval.type,
          approval.decision,
          approval.actorId,
          approval.planHash,
          approval.scopeHash,
          JSON.stringify(approval.body || {})
        ]
      );
    },
    async approveImplementationAndDispatch(jobId, approval) {
      await runInTransaction(async (client) => {
        const result = await client.query(
          `SELECT status, current_plan_version
           FROM development_jobs
           WHERE job_id = $1
           FOR UPDATE`,
          [jobId]
        );
        if (!result.rowCount) throw notFound();
        const current = result.rows[0];
        if (current.status !== DEVELOPMENT_JOB_STATES.AWAITING_IMPLEMENTATION_APPROVAL) {
          throw stateConflict(`Expected job ${jobId} to be ${DEVELOPMENT_JOB_STATES.AWAITING_IMPLEMENTATION_APPROVAL} but found ${current.status}.`);
        }
        await client.query(
          `INSERT INTO job_approvals (approval_id, job_id, approval_type, decision, actor_id, plan_hash, scope_hash, body)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            approval.approvalId,
            jobId,
            'IMPLEMENTATION',
            'APPROVED',
            approval.actorId,
            approval.planHash,
            approval.scopeHash,
            JSON.stringify(approval.body || {})
          ]
        );
        await client.query(
          `INSERT INTO job_dispatches (dispatch_key, job_id, action, actor_id, status)
           VALUES ($1, $2, $3, $4, 'PENDING')
           ON CONFLICT (dispatch_key) DO NOTHING`,
          [approval.dispatchKey, jobId, 'implement', approval.actorId]
        );
        await client.query(
          `UPDATE development_jobs
           SET status = $2, updated_at = now()
           WHERE job_id = $1`,
          [jobId, DEVELOPMENT_JOB_STATES.IMPLEMENTING]
        );
        await client.query(
          `INSERT INTO job_events (job_id, event_type, actor_id, body)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [jobId, 'STATE_TRANSITION', approval.actorId, JSON.stringify({ from: current.status, to: DEVELOPMENT_JOB_STATES.IMPLEMENTING, approvalId: approval.approvalId })]
        );
      });
    },
    async claimDispatch(dispatchKey) {
      return runInTransaction(async (client) => {
        const result = await client.query(
          `UPDATE job_dispatches
           SET status = 'DISPATCHING', updated_at = now()
           WHERE dispatch_key = $1 AND status = 'PENDING'
           RETURNING dispatch_key, job_id, action, actor_id, status`,
          [dispatchKey]
        );
        if (!result.rowCount) return null;
        const row = result.rows[0];
        return {
          dispatchKey: row.dispatch_key,
          jobId: row.job_id,
          action: row.action,
          actorId: row.actor_id,
          status: row.status
        };
      });
    },
    async markDispatchDispatched(dispatchKey) {
      await db.query(
        `UPDATE job_dispatches
         SET status = 'DISPATCHED', dispatched_at = now(), updated_at = now()
         WHERE dispatch_key = $1`,
        [dispatchKey]
      );
    },
    async transition(jobId, expectedState, nextState, details = {}) {
      await runInTransaction(async (client) => {
        const result = await client.query('SELECT status FROM development_jobs WHERE job_id = $1 FOR UPDATE', [jobId]);
        if (!result.rowCount) throw notFound();
        const currentState = result.rows[0].status;
        if (currentState !== expectedState) throw stateConflict(`Expected job ${jobId} to be ${expectedState} but found ${currentState}.`);
        assertDevelopmentTransition(currentState, nextState);
        await client.query(
          `UPDATE development_jobs
           SET status = $2, updated_at = now()
           WHERE job_id = $1`,
          [jobId, nextState]
        );
        await client.query(
          `INSERT INTO job_events (job_id, event_type, actor_id, body)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [jobId, 'STATE_TRANSITION', details.actorId || 'system', JSON.stringify({ from: currentState, to: nextState, ...details })]
        );
      });
    },
    async appendEvent(jobId, event) {
      await db.query(
        `INSERT INTO job_events (job_id, event_type, actor_id, body)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [jobId, event.type, event.actorId || 'system', JSON.stringify(event.body || {})]
      );
    }
  };
}

async function hydrateJob(db, jobId, { ownsTransactions }) {
  return runReadOnlySnapshot(async (client) => hydrateJobInSnapshot(client, jobId), { db, ownsTransactions });
}

async function runReadOnlySnapshot(work, { db, ownsTransactions }) {
  if (!ownsTransactions) return work(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function hydrateJobInSnapshot(client, jobId) {
  const jobResult = await client.query(
    `SELECT job_id, user_id, org_id, prompt, status, current_plan_version, created_at, updated_at
     FROM development_jobs
     WHERE job_id = $1`,
    [jobId]
  );
  if (!jobResult.rowCount) return null;

  const [messages, plans, approvals, events, dispatches] = await Promise.all([
    client.query(
      `SELECT message_id, role, kind, text, body, created_at
       FROM job_messages
       WHERE job_id = $1
       ORDER BY created_at, message_id`,
      [jobId]
    ),
    client.query(
      `SELECT version, plan_hash, scope_hash, body, created_at
       FROM job_plans
       WHERE job_id = $1
       ORDER BY version`,
      [jobId]
    ),
    client.query(
      `SELECT approval_id, approval_type, decision, actor_id, plan_hash, scope_hash, body, created_at
       FROM job_approvals
       WHERE job_id = $1
       ORDER BY created_at, approval_id`,
      [jobId]
    ),
    client.query(
      `SELECT event_id, event_type, actor_id, body, created_at
       FROM job_events
       WHERE job_id = $1
       ORDER BY created_at, event_id`,
      [jobId]
    ),
    client.query(
      `SELECT dispatch_key, action, actor_id, status, attempts, last_error, created_at, updated_at, dispatched_at
       FROM job_dispatches
       WHERE job_id = $1
       ORDER BY created_at, dispatch_key`,
      [jobId]
    )
  ]);

  const job = jobResult.rows[0];
  return {
    jobId: job.job_id,
    userId: job.user_id,
    orgId: job.org_id,
    prompt: job.prompt,
    status: job.status,
    currentPlanVersion: job.current_plan_version,
    createdAt: job.created_at.toISOString(),
    updatedAt: job.updated_at.toISOString(),
    messages: messages.rows.map((row) => ({
      messageId: row.message_id,
      role: row.role,
      kind: row.kind,
      text: row.text,
      body: row.body,
      createdAt: row.created_at.toISOString()
    })),
    plans: plans.rows.map((row) => ({
      version: row.version,
      planHash: row.plan_hash,
      scopeHash: row.scope_hash,
      body: row.body,
      createdAt: row.created_at.toISOString()
    })),
    approvals: approvals.rows.map((row) => ({
      approvalId: row.approval_id,
      type: row.approval_type,
      decision: row.decision,
      actorId: row.actor_id,
      planHash: row.plan_hash,
      scopeHash: row.scope_hash,
      body: row.body,
      createdAt: row.created_at.toISOString()
    })),
    events: events.rows.map((row) => ({
      eventId: String(row.event_id),
      type: row.event_type,
      actorId: row.actor_id,
      body: row.body,
      createdAt: row.created_at.toISOString()
    })),
    dispatches: dispatches.rows.map((row) => ({
      dispatchKey: row.dispatch_key,
      action: row.action,
      actorId: row.actor_id,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      dispatchedAt: row.dispatched_at?.toISOString() || ''
    }))
  };
}

function notFound() {
  const error = new Error('Job not found.');
  error.statusCode = 404;
  error.code = 'JOB_NOT_FOUND';
  return error;
}

function stateConflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'INVALID_STATE_TRANSITION';
  return error;
}
