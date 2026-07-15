import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { appendConversation, appendLog, createJobRecord, getJobRecord, invalidateForPlanChange, transitionJob, updateJob } from '../src/services/jobStore.js';
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

test('a conversational revision archives artifacts and advances the plan version', async () => {
  const originalRoot = config.workspaceRoot;
  const workspace = await mkdtemp(join(tmpdir(), 'agent-job-store-'));
  config.workspaceRoot = workspace;
  const jobId = `revision-${Date.now()}`;

  try {
    await createJobRecord({ jobId, userId: 'test-user' });
    await updateJob(jobId, {
      status: JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL,
      orgContext: { orgRegistryId: 'sapa', expectedOrgId: '00DTEST' },
      plan: { planVersion: 1, planHash: 'plan-1' },
      approvals: [{ approvalType: 'IMPLEMENTATION', decision: 'APPROVED' }, { approvalType: 'DEPLOYMENT', decision: 'APPROVED' }],
      implementation: { commitHash: 'commit-1' },
      validation: { status: 'PASSED', validationId: 'validation-1' }
    });

    const revised = await invalidateForPlanChange(jobId, 'reviewer');
    assert.equal(revised.status, JOB_STATES.RECEIVED);
    assert.equal(revised.nextPlanVersion, 2);
    assert.equal(revised.context.selectedOrgRegistryId, 'sapa');
    assert.equal(revised.approvals.length, 0);
    assert.equal(revised.implementation, null);
    assert.equal(revised.validation, null);
    assert.equal(revised.revisions.length, 1);
    assert.equal(revised.revisions[0].validation.validationId, 'validation-1');
    assert.equal(revised.revisions[0].approvals.length, 2);
  } finally {
    config.workspaceRoot = originalRoot;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('conversation messages are stored independently from revision instructions', async () => {
  const originalRoot = config.workspaceRoot;
  const workspace = await mkdtemp(join(tmpdir(), 'agent-job-store-'));
  config.workspaceRoot = workspace;
  const jobId = `conversation-${Date.now()}`;

  try {
    await createJobRecord({ jobId, userId: 'test-user' });
    await appendConversation(jobId, { conversationId: 'msg-1', role: 'user', kind: 'question', text: 'What happens next?', actor: 'test-user' });
    const job = await getJobRecord(jobId);
    assert.equal(job.conversation.length, 1);
    assert.equal(job.conversation[0].text, 'What happens next?');
    assert.equal(job.instructions.length, 0);
  } finally {
    config.workspaceRoot = originalRoot;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('completed jobs can be reopened by a new instruction revision', async () => {
  const originalRoot = config.workspaceRoot;
  const workspace = await mkdtemp(join(tmpdir(), 'agent-job-store-'));
  config.workspaceRoot = workspace;
  const jobId = `reopen-${Date.now()}`;

  try {
    await createJobRecord({ jobId, userId: 'test-user' });
    await updateJob(jobId, {
      status: JOB_STATES.COMPLETED,
      orgContext: { orgRegistryId: 'sapa', expectedOrgId: '00DTEST' },
      plan: { planVersion: 1, planHash: 'plan-1' },
      deployment: { deploymentId: 'deploy-1' }
    });

    const revised = await invalidateForPlanChange(jobId, 'reviewer');
    assert.equal(revised.status, JOB_STATES.RECEIVED);
    assert.equal(revised.nextPlanVersion, 2);
    assert.equal(revised.deployment, null);
    assert.equal(revised.context.selectedOrgRegistryId, 'sapa');
  } finally {
    config.workspaceRoot = originalRoot;
    await rm(workspace, { recursive: true, force: true });
  }
});
