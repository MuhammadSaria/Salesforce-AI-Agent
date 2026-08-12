import { nanoid } from 'nanoid';
import { JOB_STATES, assertTransition } from '../domain/jobState.js';

export function createPostgresJobRecordStore({ pool }) {
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
      return result.rows[0]?.record || null;
    },
    async list() {
      const result = await pool.query('SELECT record FROM development_jobs ORDER BY created_at DESC, job_id DESC');
      return result.rows.map((row) => row.record).filter(Boolean);
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
