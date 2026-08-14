import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponentLockService, startComponentLockHeartbeat, withComponentLocks } from '../src/services/componentLockService.js';
import { createPostgresJobStore } from '../src/persistence/jobStore.js';
import { migrate } from '../src/persistence/migrate.js';
import { createTestPostgresPool, resetPostgresSchema } from './helpers/postgres.js';

const FLOW = 'Flow:RD_Installment';
const OTHER_FLOW = 'Flow:Other';
const FIELD = 'CustomField:GiftTransaction.Installment_Number__c';

test('PostgreSQL component leases are atomic, renewable, and expiry recoverable', async (t) => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool);
    await migrate(pool);
    for (const jobId of ['a', 'b', 'c', 'd', '_direct']) {
      await pool.query(
        `INSERT INTO development_jobs (job_id, user_id, org_id, prompt, status, record)
         VALUES ($1, '005-user', '00D-org', 'Task 10 test', 'IMPLEMENTING', $2::jsonb)`,
        [jobId, JSON.stringify({ jobId, status: 'IMPLEMENTING', plan: { planVersion: 1 } })]
      );
    }
    const locks = createComponentLockService({ jobStore: createPostgresJobStore({ pool }) });
    const tokens = {};

    await t.test('accepts the full Nano ID alphabet for direct-chat job IDs', async () => {
      const acquired = await locks.acquireComponentLocks({ jobId: '_direct', componentKeys: ['Flow:Underscore'], leaseSeconds: 60 });
      await locks.releaseComponentLocks({ jobId: '_direct', componentKeys: ['Flow:Underscore'], lockToken: acquired.lockToken });
    });

    await t.test('allows unrelated jobs and rejects a conflicting component', async () => {
      tokens.aFlow = (await locks.acquireComponentLocks({ jobId: 'a', componentKeys: [FLOW], leaseSeconds: 60 })).lockToken;
      tokens.bOther = (await locks.acquireComponentLocks({ jobId: 'b', componentKeys: [OTHER_FLOW], leaseSeconds: 60 })).lockToken;
      await assert.rejects(
        () => locks.acquireComponentLocks({ jobId: 'c', componentKeys: [FLOW], leaseSeconds: 60 }),
        (error) => error.code === 'COMPONENT_LOCKED' && !error.message.includes('job a')
      );
    });

    await t.test('multi-component conflict is atomic and leaves no partial lock', async () => {
      await assert.rejects(
        () => locks.acquireComponentLocks({ jobId: 'c', componentKeys: [FIELD, FLOW], leaseSeconds: 60 }),
        (error) => error.code === 'COMPONENT_LOCKED'
      );
      const partial = await pool.query('SELECT component_key FROM component_locks WHERE job_id = $1', ['c']);
      assert.deepEqual(partial.rows, []);
      tokens.dField = (await locks.acquireComponentLocks({ jobId: 'd', componentKeys: [FIELD], leaseSeconds: 60 })).lockToken;
    });

    await t.test('same-job reacquisition and owner renewal are safe', async () => {
      const staleSameJobToken = tokens.aFlow;
      tokens.aFlow = (await locks.acquireComponentLocks({ jobId: 'a', componentKeys: [FLOW, FLOW], leaseSeconds: 60 })).lockToken;
      await assert.doesNotReject(() => locks.renewComponentLocks({ jobId: 'a', componentKeys: [FLOW], lockToken: tokens.aFlow, leaseSeconds: 60 }));
      await assert.rejects(
        () => locks.renewComponentLocks({ jobId: 'a', componentKeys: [FLOW], lockToken: staleSameJobToken, leaseSeconds: 60 }),
        (error) => error.code === 'COMPONENT_LOCK_LOST'
      );
      await locks.releaseComponentLocks({ jobId: 'a', componentKeys: [FLOW], lockToken: staleSameJobToken });
      await assert.doesNotReject(() => locks.assertComponentLocksOwned({ jobId: 'a', componentKeys: [FLOW], lockToken: tokens.aFlow }));
      await assert.rejects(
        () => locks.updateWithComponentLocks({ jobId: 'a', componentKeys: [FLOW], lockToken: staleSameJobToken }, () => {}),
        (error) => error.code === 'COMPONENT_LOCK_LOST'
      );
      await locks.updateWithComponentLocks({ jobId: 'a', componentKeys: [FLOW], lockToken: tokens.aFlow }, (record) => { record.implementationBaseline = { fenced: true }; });
      assert.deepEqual((await pool.query('SELECT record FROM development_jobs WHERE job_id = $1', ['a'])).rows[0].record.implementationBaseline, { fenced: true });
      await assert.rejects(
        () => locks.renewComponentLocks({ jobId: 'c', componentKeys: [FLOW], lockToken: 'not-owner-token', leaseSeconds: 60 }),
        (error) => error.code === 'COMPONENT_LOCK_LOST'
      );
    });

    await t.test('only the owner releases and release is idempotent', async () => {
      await locks.releaseComponentLocks({ jobId: 'c', componentKeys: [FLOW], lockToken: 'not-owner-token' });
      await assert.rejects(
        () => locks.acquireComponentLocks({ jobId: 'c', componentKeys: [FLOW], leaseSeconds: 60 }),
        (error) => error.code === 'COMPONENT_LOCKED'
      );
      await locks.releaseComponentLocks({ jobId: 'a', componentKeys: [FLOW], lockToken: tokens.aFlow });
      await locks.releaseComponentLocks({ jobId: 'a', componentKeys: [FLOW], lockToken: tokens.aFlow });
      tokens.cFlow = (await locks.acquireComponentLocks({ jobId: 'c', componentKeys: [FLOW], leaseSeconds: 60 })).lockToken;
    });

    await t.test('expired lease is reclaimable and stale owner cannot renew or release it', async () => {
      await locks.releaseComponentLocks({ jobId: 'b', componentKeys: [OTHER_FLOW], lockToken: tokens.bOther });
      const staleToken = (await locks.acquireComponentLocks({ jobId: 'a', componentKeys: [OTHER_FLOW], leaseSeconds: 0.05 })).lockToken;
      await pool.query('SELECT pg_sleep(0.08)');
      tokens.bOther = (await locks.acquireComponentLocks({ jobId: 'b', componentKeys: [OTHER_FLOW], leaseSeconds: 60 })).lockToken;
      await assert.rejects(
        () => locks.renewComponentLocks({ jobId: 'a', componentKeys: [OTHER_FLOW], lockToken: staleToken, leaseSeconds: 60 }),
        (error) => error.code === 'COMPONENT_LOCK_LOST'
      );
      await locks.releaseComponentLocks({ jobId: 'a', componentKeys: [OTHER_FLOW], lockToken: staleToken });
      const owner = await pool.query('SELECT job_id FROM component_locks WHERE component_key = $1', [OTHER_FLOW]);
      assert.equal(owner.rows[0].job_id, 'b');
    });

    await t.test('racing acquisition produces exactly one owner', async () => {
      await locks.releaseComponentLocks({ jobId: 'c', componentKeys: [FLOW], lockToken: tokens.cFlow });
      const results = await Promise.allSettled([
        locks.acquireComponentLocks({ jobId: 'a', componentKeys: [FLOW], leaseSeconds: 60 }),
        locks.acquireComponentLocks({ jobId: 'b', componentKeys: [FLOW], leaseSeconds: 60 })
      ]);
      assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
      assert.equal(results.filter((item) => item.status === 'rejected' && item.reason.code === 'COMPONENT_LOCKED').length, 1);
    });

    await t.test('rejects empty, malformed, and unsupported component keys', async () => {
      for (const componentKeys of [[], [''], ['Unknown:Thing'], ['Flow:../Thing'], ['flow:Thing']]) {
        await assert.rejects(
          async () => locks.acquireComponentLocks({ jobId: 'a', componentKeys, leaseSeconds: 60 }),
          (error) => error.code === 'INVALID_COMPONENT_LOCK_REQUEST'
        );
      }
    });
  } finally {
    await pool.end();
  }
});

test('lock scope releases on success and every controlled failure lifecycle', async () => {
  for (const outcome of ['success', 'validation failure', 'implementation failure', 'model failure', 'cancellation']) {
    const calls = [];
    const locks = fakeLocks(calls);
    const work = () => outcome === 'success' ? 'done' : Promise.reject(new Error(outcome));
    if (outcome === 'success') {
      assert.equal(await withComponentLocks({ locks, jobId: 'job', componentKeys: [FLOW], leaseSeconds: 60 }, work), 'done');
    } else {
      await assert.rejects(withComponentLocks({ locks, jobId: 'job', componentKeys: [FLOW], leaseSeconds: 60 }, work), new RegExp(outcome));
    }
    assert.deepEqual(calls, ['acquire', 'release']);
  }
});

test('heartbeat renews, reports lease loss, and stops cleanly', async () => {
  let callback;
  let cleared = 0;
  const scheduler = {
    setInterval(fn) { callback = fn; return 7; },
    clearInterval(id) { assert.equal(id, 7); cleared += 1; }
  };
  const calls = [];
  let lost = null;
  const locks = fakeLocks(calls);
  const heartbeat = startComponentLockHeartbeat({ locks, jobId: 'job', componentKeys: [FLOW], lockToken: 'heartbeat-token', leaseSeconds: 60, scheduler, onLeaseLost: (error) => { lost = error; } });
  await callback();
  assert.deepEqual(calls, ['renew']);
  locks.renewComponentLocks = async () => { throw Object.assign(new Error('lost'), { code: 'COMPONENT_LOCK_LOST' }); };
  await callback();
  assert.equal(lost.code, 'COMPONENT_LOCK_LOST');
  assert.equal(cleared, 1);
  heartbeat.stop();
  assert.equal(cleared, 2);
});

function fakeLocks(calls) {
  return {
    async acquireComponentLocks() { calls.push('acquire'); return { lockToken: 'fake-lock-token' }; },
    async renewComponentLocks(request) { assert.match(request.lockToken, /token/); calls.push('renew'); },
    async releaseComponentLocks() { calls.push('release'); },
    async assertComponentLocksOwned() { calls.push('assert'); }
  };
}
