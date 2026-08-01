import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobRepository } from '../src/persistence/jobRepository.js';
import { migrate } from '../src/persistence/migrate.js';
import { createTestPostgresPool, postgresIsAvailable, resetPostgresSchema } from './helpers/postgres.js';

test('persists a job, conversation, plan, approval, and transition atomically', async (t) => {
  const pool = createTestPostgresPool();

  try {
    if (!(await postgresIsAvailable(pool))) {
      t.skip('PostgreSQL is unavailable; start docker compose postgres to run this integration test.');
      return;
    }

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

test('component locks allow only one active lease per component', async (t) => {
  const pool = createTestPostgresPool();

  try {
    if (!(await postgresIsAvailable(pool))) {
      t.skip('PostgreSQL is unavailable; start docker compose postgres to run this integration test.');
      return;
    }

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
