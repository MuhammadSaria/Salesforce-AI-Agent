import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresJobStore } from '../src/persistence/jobStore.js';
import { migrate } from '../src/persistence/migrate.js';
import { createTestPostgresPool, resetPostgresSchema } from './helpers/postgres.js';

test('approval mutation and durable dispatch commit atomically with revision CAS', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool); await migrate(pool);
    const store = createPostgresJobStore({ pool });
    const created = await store.create({ jobId: 'atomic-approval', userId: 'u', orgId: 'o', prompt: 'p' });
    await store.update(created.jobId, { status: 'AWAITING_IMPLEMENTATION_APPROVAL' });
    const job = await store.get(created.jobId);
    const mutate = (record) => {
      record.status = 'IMPLEMENTING';
      record.approvals.push({ approvalId: 'approval-one', decision: 'APPROVED' });
      return { result: { approvalId: 'approval-one' }, dispatch: { dispatchKey: 'atomic-approval:implement:1', jobId: record.jobId, action: 'implement', actor: 'u' } };
    };
    const outcomes = await Promise.allSettled([
      store.approveImplementationAtomically(job.jobId, job.revision, mutate),
      store.approveImplementationAtomically(job.jobId, job.revision, mutate)
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((item) => item.status === 'rejected' && item.reason.code === 'STALE_REVISION').length, 1);
    const after = await store.get(job.jobId);
    assert.equal(after.revision, job.revision + 1);
    assert.equal(after.approvals.length, 1);
    assert.equal(after.dispatches.length, 1);
  } finally { await pool.end(); }
});

test('atomic mutation rollback leaves job revision and dispatch unchanged', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool); await migrate(pool);
    const store = createPostgresJobStore({ pool });
    const job = await store.create({ jobId: 'atomic-rollback', userId: 'u', orgId: 'o', prompt: 'p' });
    await assert.rejects(() => store.approveImplementationAtomically(job.jobId, job.revision, (record) => {
      record.approvals.push({ approvalId: 'must-rollback' });
      return { result: {}, dispatch: { dispatchKey: 'must-rollback', jobId: record.jobId, action: 'implement', actor: 'u', invalidForTest: true } };
    }));
    const after = await store.get(job.jobId);
    assert.equal(after.revision, job.revision);
    assert.deepEqual(after.approvals, []);
    assert.deepEqual(after.dispatches, []);
  } finally { await pool.end(); }
});

test('clarification acceptance is one CAS mutation with one durable understand dispatch', async () => {
  const pool = createTestPostgresPool();
  try {
    await resetPostgresSchema(pool); await migrate(pool);
    const store = createPostgresJobStore({ pool });
    await store.create({ jobId: 'atomic-clarification', userId: 'u', orgId: 'o', prompt: 'p' });
    await store.update('atomic-clarification', { status: 'AWAITING_CLARIFICATION', clarifications: [{ ambiguityId: 'a', status: 'OPEN' }] });
    const job = await store.get('atomic-clarification');
    const mutation = (record) => {
      const open = record.clarifications.filter((item) => item.status === 'OPEN');
      if (open.length !== 1) throw Object.assign(new Error('stale clarification'), { code: 'CLARIFICATION_CONTEXT_STALE' });
      open[0].status = 'RESOLVED';
      record.conversation.push({ conversationId: 'answer', kind: 'clarification-response', text: 'Paid' });
      record.audit.push({ action: 'CLARIFICATION_ACCEPTED' });
      record.status = 'UNDERSTANDING';
      return { result: { messageId: 'answer' }, dispatch: { dispatchKey: 'atomic-clarification:understand:a', jobId: record.jobId, action: 'understand', actor: 'u' } };
    };
    const outcomes = await Promise.allSettled([
      store.appendConversationAtomically(job.jobId, job.revision, mutation),
      store.appendConversationAtomically(job.jobId, job.revision, mutation)
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
    const after = await store.get(job.jobId);
    assert.equal(after.revision, job.revision + 1);
    assert.equal(after.conversation.length, 1);
    assert.equal(after.audit.length, 1);
    assert.equal(after.dispatches.length, 1);
  } finally { await pool.end(); }
});
