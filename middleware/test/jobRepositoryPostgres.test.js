import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobRepository } from '../src/persistence/jobRepository.js';
import { migrate } from '../src/persistence/migrate.js';
import { createTestPostgresPool, resetPostgresSchema } from './helpers/postgres.js';

test('persists a job, conversation, plan, approval, and transition atomically', async () => {
  const pool = createTestPostgresPool();

  try {
    await resetPostgresSchema(pool);
    await migrate(pool);

    const repository = createJobRepository({ pool });
    await repository.createJob({ jobId: 'job-1', userId: '005-user', orgId: '00D-org', prompt: 'Create a Flow' });
    await repository.appendMessage('job-1', { messageId: 'm-1', role: 'user', kind: 'requirement', text: 'Create a Flow' });
    await repository.savePlan('job-1', { version: 1, planHash: 'plan-hash', scopeHash: 'scope-hash', body: { expectedOutcome: 'Inactive Flow' } });
    await repository.appendApproval('job-1', { approvalId: 'a-1', type: 'IMPLEMENTATION', decision: 'APPROVED', actorId: '005-admin', planHash: 'plan-hash', scopeHash: 'scope-hash' });
    await repository.transition('job-1', 'AWAITING_IMPLEMENTATION_APPROVAL', 'IMPLEMENTING', { actorId: '005-admin' });

    const job = await repository.getJob('job-1');
    assert.equal(job.status, 'IMPLEMENTING');
    assert.equal(job.messages[0].text, 'Create a Flow');
    assert.equal(job.plans[0].planHash, 'plan-hash');
    assert.equal(job.approvals[0].decision, 'APPROVED');
  } finally {
    await pool.end();
  }
});

test('component locks allow only one active lease per component', async () => {
  const pool = createTestPostgresPool();

  try {
    await resetPostgresSchema(pool);
    await migrate(pool);

    await pool.query(
      `INSERT INTO development_jobs (job_id, user_id, org_id, prompt, status)
       VALUES ($1, $2, $3, $4, $5)`,
      ['job-locks', '005-user', '00D-org', 'Create a Flow', 'RECEIVED']
    );
    await pool.query(
      `INSERT INTO component_locks (lock_id, job_id, component_key, lease_expires_at)
       VALUES ($1, $2, $3, now() + interval '5 minutes')`,
      ['lock-1', 'job-locks', 'Flow:Donation_Numbering']
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO component_locks (lock_id, job_id, component_key, lease_expires_at)
         VALUES ($1, $2, $3, now() + interval '5 minutes')`,
        ['lock-2', 'job-locks', 'Flow:Donation_Numbering']
      ),
      /duplicate key value violates unique constraint/
    );
  } finally {
    await pool.end();
  }
});

test('rolls back composed repository writes in one transaction', async () => {
  const pool = createTestPostgresPool();

  try {
    await resetPostgresSchema(pool);
    await migrate(pool);

    const repository = createJobRepository({ pool });
    await assert.rejects(
      repository.withTransaction(async (txRepository) => {
        await txRepository.createJob({ jobId: 'job-rollback', userId: '005-user', orgId: '00D-org', prompt: 'Create a Flow' });
        await txRepository.appendMessage('job-rollback', { messageId: 'm-rollback', role: 'user', kind: 'requirement', text: 'Create a Flow' });
        await txRepository.savePlan('job-rollback', { version: 1, planHash: 'plan-hash', scopeHash: 'scope-hash', body: { expectedOutcome: 'Inactive Flow' } });
        await txRepository.appendApproval('job-rollback', { approvalId: 'a-rollback', type: 'IMPLEMENTATION', decision: 'APPROVED', actorId: '005-admin', planHash: 'plan-hash', scopeHash: 'scope-hash' });
        await txRepository.transition('job-rollback', 'AWAITING_IMPLEMENTATION_APPROVAL', 'IMPLEMENTING', { actorId: '005-admin' });
        throw new Error('force rollback');
      }),
      /force rollback/
    );

    assert.equal(await repository.getJob('job-rollback'), null);
  } finally {
    await pool.end();
  }
});

test('commits composed repository writes in one transaction', async () => {
  const pool = createTestPostgresPool();

  try {
    await resetPostgresSchema(pool);
    await migrate(pool);

    const repository = createJobRepository({ pool });
    await repository.withTransaction(async (txRepository) => {
      await txRepository.createJob({ jobId: 'job-commit', userId: '005-user', orgId: '00D-org', prompt: 'Create a Flow' });
      await txRepository.appendMessage('job-commit', { messageId: 'm-commit', role: 'user', kind: 'requirement', text: 'Create a Flow' });
      await txRepository.savePlan('job-commit', { version: 1, planHash: 'plan-hash', scopeHash: 'scope-hash', body: { expectedOutcome: 'Inactive Flow' } });
      await txRepository.appendApproval('job-commit', { approvalId: 'a-commit', type: 'IMPLEMENTATION', decision: 'APPROVED', actorId: '005-admin', planHash: 'plan-hash', scopeHash: 'scope-hash' });
      await txRepository.transition('job-commit', 'AWAITING_IMPLEMENTATION_APPROVAL', 'IMPLEMENTING', { actorId: '005-admin' });
    });

    const job = await repository.getJob('job-commit');
    assert.equal(job.status, 'IMPLEMENTING');
    assert.equal(job.messages.length, 1);
    assert.equal(job.plans.length, 1);
    assert.equal(job.approvals.length, 1);
    assert.equal(job.events.length, 1);
  } finally {
    await pool.end();
  }
});

test('records approval and dispatch in one PostgreSQL transaction', async () => {
  const pool = createTestPostgresPool();

  try {
    await resetPostgresSchema(pool);
    await migrate(pool);

    const repository = createJobRepository({ pool });
    await repository.createJob({ jobId: 'job-outbox', userId: '005-user', orgId: '00D-org', prompt: 'Create a Flow' });
    await repository.savePlan('job-outbox', { version: 1, planHash: 'plan-hash', scopeHash: 'scope-hash', body: {} });
    await repository.approveImplementationAndDispatch('job-outbox', {
      approvalId: 'a-outbox',
      actorId: '005-admin',
      planHash: 'plan-hash',
      scopeHash: 'scope-hash',
      dispatchKey: 'job-outbox:implement:v1:plan-hash:005-admin'
    });

    const job = await repository.getJob('job-outbox');
    assert.equal(job.status, 'IMPLEMENTING');
    assert.equal(job.approvals[0].approvalId, 'a-outbox');
    assert.equal(job.dispatches[0].dispatchKey, 'job-outbox:implement:v1:plan-hash:005-admin');
    assert.equal(job.dispatches[0].status, 'PENDING');
  } finally {
    await pool.end();
  }
});

test('PostgreSQL dispatch claims are idempotent under duplicate delivery attempts', async () => {
  const pool = createTestPostgresPool();

  try {
    await resetPostgresSchema(pool);
    await migrate(pool);

    const repository = createJobRepository({ pool });
    await repository.createJob({ jobId: 'job-claim', userId: '005-user', orgId: '00D-org', prompt: 'Create a Flow' });
    await repository.savePlan('job-claim', { version: 1, planHash: 'plan-hash', scopeHash: 'scope-hash', body: {} });
    await repository.approveImplementationAndDispatch('job-claim', {
      approvalId: 'a-claim',
      actorId: '005-admin',
      planHash: 'plan-hash',
      scopeHash: 'scope-hash',
      dispatchKey: 'job-claim:implement:v1:plan-hash:005-admin'
    });

    const [first, second] = await Promise.all([
      repository.claimDispatch('job-claim:implement:v1:plan-hash:005-admin'),
      repository.claimDispatch('job-claim:implement:v1:plan-hash:005-admin')
    ]);

    assert.equal([first, second].filter(Boolean).length, 1);
    await repository.markDispatchDispatched('job-claim:implement:v1:plan-hash:005-admin');
    assert.equal(await repository.claimDispatch('job-claim:implement:v1:plan-hash:005-admin'), null);
  } finally {
    await pool.end();
  }
});

test('migration 002 upgrades a database that already recorded released 001', async () => {
  const pool = createTestPostgresPool();

  try {
    await resetPostgresSchema(pool);
    await applyReleased001(pool);
    await pool.query(`INSERT INTO schema_migrations (filename) VALUES ('001_phase1_jobs.sql')`);

    await migrate(pool);

    const dispatchTable = await pool.query(`SELECT to_regclass('public.job_dispatches') AS table_name`);
    const indexes = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'job_dispatches'
      ORDER BY indexname
    `);
    const migrations = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');

    assert.equal(dispatchTable.rows[0].table_name, 'job_dispatches');
    assert.deepEqual(migrations.rows.map((row) => row.filename), ['001_phase1_jobs.sql', '002_task6_job_dispatches.sql']);
    assert.ok(indexes.rows.some((row) => row.indexname === 'job_dispatches_claimable_idx'));
    assert.ok(indexes.rows.some((row) => row.indexname === 'job_dispatches_job_id_created_at_idx'));

    await migrate(pool);
    const repeated = await pool.query('SELECT filename, count(*)::int AS count FROM schema_migrations GROUP BY filename ORDER BY filename');
    assert.deepEqual(repeated.rows, [
      { filename: '001_phase1_jobs.sql', count: 1 },
      { filename: '002_task6_job_dispatches.sql', count: 1 }
    ]);
  } finally {
    await pool.end();
  }
});

test('dispatch leases recover after crash and are not reclaimed once delivered', async () => {
  const pool = createTestPostgresPool();

  try {
    await resetPostgresSchema(pool);
    await migrate(pool);

    const repository = createJobRepository({ pool, dispatchLeaseMs: 200, workerId: 'worker-a' });
    await repository.createJob({ jobId: 'job-lease', userId: '005-user', orgId: '00D-org', prompt: 'Create a Flow' });
    await repository.savePlan('job-lease', { version: 1, planHash: 'plan-hash', scopeHash: 'scope-hash', body: {} });
    await repository.approveImplementationAndDispatch('job-lease', {
      approvalId: 'a-lease',
      actorId: '005-admin',
      planHash: 'plan-hash',
      scopeHash: 'scope-hash',
      dispatchKey: 'job-lease:implement:v1:plan-hash:005-admin'
    });

    const first = await repository.claimNextDispatch();
    assert.equal(first.dispatchKey, 'job-lease:implement:v1:plan-hash:005-admin');
    assert.equal(first.status, 'DISPATCHING');
    assert.equal(first.claimantId, 'worker-a');
    assert.equal(first.attempts, 1);
    assert.equal(await createJobRepository({ pool, workerId: 'worker-b' }).claimNextDispatch(), null);

    await new Promise((resolve) => setTimeout(resolve, 240));
    const reclaimer = createJobRepository({ pool, dispatchLeaseMs: 1000, workerId: 'worker-b' });
    const reclaimed = await reclaimer.claimNextDispatch();
    assert.equal(reclaimed.dispatchKey, first.dispatchKey);
    assert.equal(reclaimed.claimantId, 'worker-b');
    assert.equal(reclaimed.attempts, 2);

    await reclaimer.markDispatchDispatched(reclaimed.dispatchKey);
    assert.equal(await createJobRepository({ pool, workerId: 'worker-c' }).claimNextDispatch(), null);
  } finally {
    await pool.end();
  }
});

test('hydrates a job through one repeatable-read transaction', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql: normalizeSql(sql), params });
      if (sql.includes('FROM development_jobs')) {
        return {
          rowCount: 1,
          rows: [{
            job_id: 'job-snapshot',
            user_id: '005-user',
            org_id: '00D-org',
            prompt: 'Create a Flow',
            status: 'RECEIVED',
            current_plan_version: 0,
            created_at: new Date('2026-08-01T00:00:00.000Z'),
            updated_at: new Date('2026-08-01T00:00:00.000Z')
          }]
        };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() {
      return client;
    }
  };

  const repository = createJobRepository({ pool });
  const job = await repository.getJob('job-snapshot');

  assert.equal(job.jobId, 'job-snapshot');
  assert.equal(queries[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(queries.filter((query) => query.params[0] === 'job-snapshot').length, 6);
});

test('serializes concurrent migration runners and records each filename once', async () => {
  const pool = createTestPostgresPool();

  try {
    await resetPostgresSchema(pool);
    await Promise.all([migrate(pool), migrate(pool)]);

    const result = await pool.query(
      `SELECT filename, count(*)::int AS count
       FROM schema_migrations
       GROUP BY filename
       ORDER BY filename`
    );

    assert.deepEqual(result.rows, [
      { filename: '001_phase1_jobs.sql', count: 1 },
      { filename: '002_task6_job_dispatches.sql', count: 1 }
    ]);
  } finally {
    await pool.end();
  }
});

test('migration execution is idempotent after the first successful run', async () => {
  const pool = createTestPostgresPool();

  try {
    await resetPostgresSchema(pool);
    await migrate(pool);
    await migrate(pool);

    const result = await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
    assert.equal(result.rows[0].count, 2);
  } finally {
    await pool.end();
  }
});

function normalizeSql(sql) {
  return sql.trim().replace(/\s+/g, ' ');
}

async function applyReleased001(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS development_jobs (
      job_id text PRIMARY KEY,
      user_id text NOT NULL,
      org_id text NOT NULL,
      prompt text NOT NULL,
      status text NOT NULL,
      current_plan_version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS job_messages (
      message_id text PRIMARY KEY,
      job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
      role text NOT NULL,
      kind text NOT NULL,
      text text NOT NULL,
      body jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS job_plans (
      plan_id bigserial PRIMARY KEY,
      job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
      version integer NOT NULL,
      plan_hash text NOT NULL,
      scope_hash text NOT NULL,
      body jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (job_id, version)
    );

    CREATE TABLE IF NOT EXISTS job_approvals (
      approval_id text PRIMARY KEY,
      job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
      approval_type text NOT NULL,
      decision text NOT NULL,
      actor_id text NOT NULL,
      plan_hash text NOT NULL,
      scope_hash text NOT NULL,
      body jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS job_events (
      event_id bigserial PRIMARY KEY,
      job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
      event_type text NOT NULL,
      actor_id text NOT NULL DEFAULT 'system',
      body jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS component_locks (
      lock_id text PRIMARY KEY,
      job_id text NOT NULL REFERENCES development_jobs(job_id) ON DELETE RESTRICT,
      component_key text NOT NULL,
      lease_expires_at timestamptz NOT NULL,
      released_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}
