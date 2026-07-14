import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { appendLog, createJobRecord, getJobRecord, transitionJob, updateJob } from '../src/services/jobStore.js';
import { JOB_STATES } from '../src/domain/jobState.js';

test('job snapshots survive memory loss and concurrent mutations are serialized', async () => {
  const originalRoot = config.workspaceRoot;
  const workspace = await mkdtemp(join(tmpdir(), 'agent-job-store-'));
  config.workspaceRoot = workspace;
  const jobId = `durable-${Date.now()}`;

  try {
    await createJobRecord({ jobId, userId: 'test-user' });
    await Promise.all(Array.from({ length: 20 }, (_, index) => appendLog(jobId, 'info', `event-${index}`)));

    const job = await getJobRecord(jobId);
    assert.equal(job.logs.length, 21);
    const snapshot = JSON.parse(await readFile(join(workspace, 'jobs', jobId, 'record.json'), 'utf8'));
    assert.equal(snapshot.logs.length, 21);
  } finally {
    config.workspaceRoot = originalRoot;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('successful progress clears a stale job error', async () => {
  const originalRoot = config.workspaceRoot;
  const workspace = await mkdtemp(join(tmpdir(), 'agent-job-store-'));
  config.workspaceRoot = workspace;
  const jobId = `clear-error-${Date.now()}`;

  try {
    await createJobRecord({ jobId, userId: 'test-user' });
    await updateJob(jobId, { error: 'old validation failure' });
    await transitionJob(jobId, JOB_STATES.VERIFYING_ORG, { actor: 'test' });
    assert.equal((await getJobRecord(jobId)).error, '');
  } finally {
    config.workspaceRoot = originalRoot;
    await rm(workspace, { recursive: true, force: true });
  }
});
