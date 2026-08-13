import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresJobStore } from '../src/persistence/jobStore.js';
import { migrate } from '../src/persistence/migrate.js';
import { createTestPostgresPool, resetPostgresSchema } from './helpers/postgres.js';

test('migration 003 upgrades concurrently and records retry scheduling columns once', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool);
    await Promise.all([migrate(pool), migrate(pool)]);
    const migrations = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    assert.deepEqual(migrations.rows.map((row) => row.filename), ['001_phase1_jobs.sql', '002_task6_job_dispatches.sql', '003_task6_dispatch_retry.sql', '004_task10_component_leases.sql']);
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='job_dispatches'");
    for (const name of ['next_attempt_at', 'terminal_at', 'terminal_reason']) assert.ok(columns.rows.some((row) => row.column_name === name));
  } finally { await pool.end(); }
});

test('retryable dispatch is not claimable before backoff and becomes terminal at max attempts', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool); await migrate(pool);
    const store = createPostgresJobStore({ pool, claimantId: 'retry-policy', dispatchRetryBaseMs: 60000, dispatchMaxAttempts: 2 });
    await store.create({ jobId: 'retry-policy-job', userId: 'u', orgId: 'o', prompt: 'p' });
    await store.createDispatch({ dispatchKey: 'retry-policy-key', jobId: 'retry-policy-job', action: 'implement', actor: 'u' });
    assert.ok(await store.claimNextDispatch());
    await store.markDispatchRetryable('retry-policy-key', new Error('redis secret should be bounded'));
    assert.equal(await store.claimNextDispatch(), null);
    await pool.query("UPDATE job_dispatches SET next_attempt_at = now() - interval '1 second' WHERE dispatch_key=$1", ['retry-policy-key']);
    assert.ok(await store.claimNextDispatch());
    await store.markDispatchRetryable('retry-policy-key', new Error('still down'));
    const dispatch = (await store.get('retry-policy-job')).dispatches[0];
    assert.equal(dispatch.status, 'TERMINAL');
    assert.ok(dispatch.terminalAt);
    assert.equal(await store.claimNextDispatch(), null);
  } finally { await pool.end(); }
});
