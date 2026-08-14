import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_JOB_STORE_METHODS, assertJobStoreContract, createMemoryJobStore, createPostgresJobStore } from '../src/persistence/jobStore.js';
import { migrate } from '../src/persistence/migrate.js';
import { createTestPostgresPool, resetPostgresSchema } from './helpers/postgres.js';

test('memory store implements the unified production JobStore contract', () => {
  assert.doesNotThrow(() => assertJobStoreContract(createMemoryJobStore()));
});

test('PostgreSQL store implements the unified production JobStore contract', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool); await migrate(pool);
    const store = createPostgresJobStore({ pool });
    assert.doesNotThrow(() => assertJobStoreContract(store));
    for (const method of REQUIRED_JOB_STORE_METHODS) assert.equal(typeof store[method], 'function', method);
  } finally { await pool.end(); }
});

test('startup contract validation rejects a missing required method', () => {
  const store = createMemoryJobStore(); delete store.appendLog;
  assert.throws(() => assertJobStoreContract(store), (error) => error.code === 'JOB_STORE_CONTRACT_INVALID');
});

test('Memory and PostgreSQL jobs initialize durable correction state with parity', async () => {
  const memory = createMemoryJobStore();
  const memoryJob = await memory.create({ jobId: `memory-correction-${Date.now()}`, source: 'salesforce-chat', orgId: '00Dg500000E07e9EAB', userId: '005-user', prompt: 'test' });
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool); await migrate(pool);
    const postgres = createPostgresJobStore({ pool });
    const postgresJob = await postgres.create({ jobId: `postgres-correction-${Date.now()}`, source: 'salesforce-chat', orgId: '00Dg500000E07e9EAB', userId: '005-user', prompt: 'test' });
    for (const job of [memoryJob, postgresJob]) {
      assert.equal(job.correctionAttempt, 0);
      assert.equal(job.correctionReservation, null);
      assert.deepEqual(job.correctionHistory, []);
    }
    await postgres.update(postgresJob.jobId, { correctionAttempt: 2, correctionHistory: [{ attempt: 1 }, { attempt: 2 }] });
    const restartedWorkerStore = createPostgresJobStore({ pool, claimantId: 'restarted-correction-worker' });
    const durable = await restartedWorkerStore.get(postgresJob.jobId);
    assert.equal(durable.correctionAttempt, 2);
    assert.deepEqual(durable.correctionHistory, [{ attempt: 1 }, { attempt: 2 }]);
  } finally { await pool.end(); }
});

test('PostgreSQL atomic mutation prevents duplicate durable correction reservations', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool); await migrate(pool);
    const store = createPostgresJobStore({ pool });
    const jobId = `postgres-correction-race-${Date.now()}`;
    await store.create({ jobId, source: 'salesforce-chat', orgId: '00Dg500000E07e9EAB', userId: '005-user', prompt: 'test' });
    const reserve = (token) => store.updateAtomically(jobId, async (record) => {
      if (record.correctionReservation) throw Object.assign(new Error('Correction already reserved.'), { code: 'CORRECTION_IN_PROGRESS' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      record.correctionReservation = { token, attempt: Number(record.correctionAttempt || 0) + 1 };
      return record.correctionReservation;
    });
    const outcomes = await Promise.allSettled([reserve('worker-a-token'), reserve('worker-b-token')]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((item) => item.status === 'rejected' && item.reason.code === 'CORRECTION_IN_PROGRESS').length, 1);
    assert.equal((await store.get(jobId)).correctionReservation.attempt, 1);
  } finally { await pool.end(); }
});
