import { DEVELOPMENT_JOB_STATES, assertDevelopmentTransition } from '../domain/developmentJob.js';

export function createJobRepository({ pool }) {
  async function withTransaction(work) {
    const client = await pool.connect();
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

  return {
    withTransaction,
    async createJob(input) {
      const now = new Date();
      await pool.query(
        `INSERT INTO development_jobs (job_id, user_id, org_id, prompt, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [input.jobId, input.userId, input.orgId, input.prompt, input.status || DEVELOPMENT_JOB_STATES.RECEIVED, now]
      );
    },
    async getJob(jobId) {
      return hydrateJob(pool, jobId);
    },
    async listJobs() {
      const result = await pool.query('SELECT job_id FROM development_jobs ORDER BY created_at DESC, job_id DESC');
      return Promise.all(result.rows.map((row) => hydrateJob(pool, row.job_id)));
    },
    async appendMessage(jobId, message) {
      await pool.query(
        `INSERT INTO job_messages (message_id, job_id, role, kind, text, body)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [message.messageId, jobId, message.role, message.kind, message.text, JSON.stringify(message.body || {})]
      );
    },
    async savePlan(jobId, plan) {
      await withTransaction(async (client) => {
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
      await pool.query(
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
    async transition(jobId, expectedState, nextState, details = {}) {
      await withTransaction(async (client) => {
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
      await pool.query(
        `INSERT INTO job_events (job_id, event_type, actor_id, body)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [jobId, event.type, event.actorId || 'system', JSON.stringify(event.body || {})]
      );
    }
  };
}

async function hydrateJob(pool, jobId) {
  const jobResult = await pool.query(
    `SELECT job_id, user_id, org_id, prompt, status, current_plan_version, created_at, updated_at
     FROM development_jobs
     WHERE job_id = $1`,
    [jobId]
  );
  if (!jobResult.rowCount) return null;

  const [messages, plans, approvals, events] = await Promise.all([
    pool.query(
      `SELECT message_id, role, kind, text, body, created_at
       FROM job_messages
       WHERE job_id = $1
       ORDER BY created_at, message_id`,
      [jobId]
    ),
    pool.query(
      `SELECT version, plan_hash, scope_hash, body, created_at
       FROM job_plans
       WHERE job_id = $1
       ORDER BY version`,
      [jobId]
    ),
    pool.query(
      `SELECT approval_id, approval_type, decision, actor_id, plan_hash, scope_hash, body, created_at
       FROM job_approvals
       WHERE job_id = $1
       ORDER BY created_at, approval_id`,
      [jobId]
    ),
    pool.query(
      `SELECT event_id, event_type, actor_id, body, created_at
       FROM job_events
       WHERE job_id = $1
       ORDER BY created_at, event_id`,
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
