import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { appendConversation, appendLog, claimFileOwnership, createJobRecord, getJobRecord, invalidateForPlanChange, releaseFileOwnership, transitionJob, updateJob } from '../src/services/jobStore.js';
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
      validation: { status: 'PASSED', validationId: 'validation-1' },
      deploymentHistory: [{ deploymentVersion: 1, deployedAt: '2026-07-15T10:00:00Z' }],
      implementationReports: [{ reportId: 'implementation-report-v1', status: 'READY', deploymentVersion: 1 }]
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
    assert.equal(revised.deploymentHistory.length, 1);
    assert.equal(revised.implementationReports.length, 1);
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

test('a specialist revision preserves completed work outside the affected agent boundary', async () => {
  const jobId = `job-specialist-revision-${Date.now()}`;
  await createJobRecord({ jobId, userId: 'user-1' });
  await updateJob(jobId, {
    orgContext: { orgRegistryId: 'org-1', expectedOrgId: '00D000000000001AAA' },
    plan: { planVersion: 1, materialChangeHash: 'material-1' },
    nextPlanVersion: 1,
    workItems: [
      { workItemId: 'object-item', assignedSpecialistAgent: 'OBJECT_FIELD', status: 'COMPLETED', iteration: 1, filesAffected: ['force-app/main/default/objects/Contact/fields/Status__c.field-meta.xml'], implementationEvidence: { completedAt: '2026-07-16T00:00:00Z', filePaths: ['force-app/main/default/objects/Contact/fields/Status__c.field-meta.xml'], dataOperationCount: 0 } },
      { workItemId: 'lwc-item', assignedSpecialistAgent: 'LWC', status: 'COMPLETED', iteration: 1, filesAffected: ['force-app/main/default/lwc/status/status.js'], implementationEvidence: { completedAt: '2026-07-16T00:00:00Z', filePaths: ['force-app/main/default/lwc/status/status.js'], dataOperationCount: 0 } },
      { workItemId: 'testing-item', assignedSpecialistAgent: 'TESTING', status: 'COMPLETED', iteration: 1 }
    ],
    implementation: { changedFiles: ['force-app/main/default/objects/Contact/fields/Status__c.field-meta.xml', 'force-app/main/default/lwc/status/status.js'] }
  });

  const revised = await invalidateForPlanChange(jobId, 'user-1', { instruction: 'Also display the field in the LWC.' });
  assert.deepEqual(revised.revisionContext.affectedAgentIds.sort(), ['DOCUMENTATION_EXPLANATION', 'LWC', 'TESTING', 'VALIDATION_DEPLOYMENT'].sort());
  assert.deepEqual(revised.workItems.map((item) => item.assignedSpecialistAgent), ['OBJECT_FIELD']);
  assert.equal(revised.workItems[0].status, 'COMPLETED');
  assert.equal(revised.nextPlanVersion, 2);
});

test('a TA-14 style proposal-only completion is reopened instead of preserved', async () => {
  const jobId = `job-proposal-only-revision-${Date.now()}`;
  await createJobRecord({ jobId, userId: 'user-1' });
  await updateJob(jobId, {
    orgContext: { orgRegistryId: 'org-1', expectedOrgId: '00D000000000001AAA' },
    plan: { planVersion: 1, materialChangeHash: 'material-1', fileOperations: [], dataOperations: [] },
    nextPlanVersion: 1,
    implementation: { changedFiles: [] },
    workItems: [
      { workItemId: 'flow-item', assignedSpecialistAgent: 'FLOW', status: 'COMPLETED', iteration: 1, filesAffected: [] },
      { workItemId: 'data-item', assignedSpecialistAgent: 'DATA', status: 'COMPLETED', iteration: 1, filesAffected: [] }
    ]
  });

  const revised = await invalidateForPlanChange(jobId, 'user-1', { instruction: 'Deploy it as well.' });
  assert.deepEqual(revised.workItems, []);
  assert.deepEqual(revised.revisionContext.preservedWorkItems, []);
});

test('file ownership permits only the approved specialist lock holder', async () => {
  const jobId = `job-file-owner-${Date.now()}`;
  const path = 'force-app/main/default/flows/Test.flow-meta.xml';
  await createJobRecord({ jobId, userId: 'user-1' });
  await updateJob(jobId, {
    fileOwnership: [{ path, owningAgent: 'FLOW', workItemId: 'flow-item', lockStatus: 'PLANNED', baselineHash: '', currentHash: '' }]
  });

  const claimed = await claimFileOwnership(jobId, path, 'flow-item', 'FLOW', 'baseline-hash');
  assert.equal(claimed.lockStatus, 'LOCKED');
  await assert.rejects(() => claimFileOwnership(jobId, path, 'other-item', 'APEX', 'baseline-hash'), /ownership mismatch|already locked/i);
  const released = await releaseFileOwnership(jobId, path, 'flow-item', 'current-hash');
  assert.equal(released.lockStatus, 'RELEASED');
  assert.equal(released.baselineHash, 'baseline-hash');
  assert.equal(released.currentHash, 'current-hash');
});
