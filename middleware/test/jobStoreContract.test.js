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
