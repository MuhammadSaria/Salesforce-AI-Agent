import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresJobStore } from '../src/persistence/jobStore.js';
import { migrate } from '../src/persistence/migrate.js';
import { startOutboxDispatcher } from '../src/queue/outboxDispatcher.js';
import { createTestPostgresPool, resetPostgresSchema } from './helpers/postgres.js';

test('dispatcher scans immediately at startup and marks accepted queue jobs delivered', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool);
    await migrate(pool);
    const store = createPostgresJobStore({ pool, claimantId: 'dispatcher-startup' });
    await seedDispatch(store, 'startup');
    const accepted = [];
    const dispatcher = startOutboxDispatcher({
      jobStore: store,
      intervalMs: 60000,
      enqueue: async (message, options) => accepted.push({ message, options })
    });
    await waitFor(async () => accepted.length === 1);
    dispatcher.stop();
    const job = await store.get('job-startup');
    assert.equal(job.dispatches[0].status, 'DELIVERED');
    assert.equal(accepted[0].options.jobId, 'dispatch-startup');
  } finally {
    await pool.end();
  }
});

test('dispatcher records retryable failure and later periodic retry delivers', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool);
    await migrate(pool);
    const store = createPostgresJobStore({ pool, claimantId: 'dispatcher-retry' });
    await seedDispatch(store, 'retry');
    let attempts = 0;
    const dispatcher = startOutboxDispatcher({
      jobStore: store,
      intervalMs: 100,
      enqueue: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('redis unavailable with secret token ignored');
      }
    });
    await waitFor(async () => (await store.get('job-retry')).dispatches[0].status === 'DELIVERED', 2000);
    dispatcher.stop();
    const dispatch = (await store.get('job-retry')).dispatches[0];
    assert.equal(dispatch.status, 'DELIVERED');
    assert.ok(dispatch.attempts >= 2);
  } finally {
    await pool.end();
  }
});

test('expired claim is recovered after a crashed dispatcher and delivered rows are not reclaimed', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool);
    await migrate(pool);
    const crashed = createPostgresJobStore({ pool, dispatchLeaseMs: 100, claimantId: 'crashed' });
    await seedDispatch(crashed, 'crash');
    const claimed = await crashed.claimNextDispatch();
    assert.equal(claimed.status, 'DISPATCHING');

    await new Promise((resolve) => setTimeout(resolve, 140));
    const recovered = createPostgresJobStore({ pool, dispatchLeaseMs: 1000, claimantId: 'recovered' });
    const dispatcher = startOutboxDispatcher({ jobStore: recovered, intervalMs: 60000, enqueue: async () => ({ id: 'ok' }) });
    await waitFor(async () => (await recovered.get('job-crash')).dispatches[0].status === 'DELIVERED');
    dispatcher.stop();

    assert.equal(await recovered.claimNextDispatch(), null);
  } finally {
    await pool.end();
  }
});

test('two dispatcher instances racing deliver one queue job and graceful shutdown stops polling', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool);
    await migrate(pool);
    const storeA = createPostgresJobStore({ pool, claimantId: 'race-a' });
    const storeB = createPostgresJobStore({ pool, claimantId: 'race-b' });
    await seedDispatch(storeA, 'race');
    const accepted = [];
    const dispatcherA = startOutboxDispatcher({ jobStore: storeA, intervalMs: 100, enqueue: async () => accepted.push('a') });
    const dispatcherB = startOutboxDispatcher({ jobStore: storeB, intervalMs: 100, enqueue: async () => accepted.push('b') });
    await waitFor(async () => accepted.length === 1);
    await waitFor(async () => (await storeA.get('job-race'))?.dispatches[0]?.status === 'DELIVERED');
    dispatcherA.stop();
    dispatcherB.stop();
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(accepted.length, 1);
    assert.equal((await storeA.get('job-race')).dispatches[0].status, 'DELIVERED');
  } finally {
    await pool.end();
  }
});

async function seedDispatch(store, suffix) {
  await store.create({ jobId: `job-${suffix}`, userId: '005-user', orgId: '00D-org', prompt: 'Create a Flow' });
  await store.createDispatch({ dispatchKey: `dispatch-${suffix}`, jobId: `job-${suffix}`, action: 'implement', actor: '005-user' });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for condition.');
}
