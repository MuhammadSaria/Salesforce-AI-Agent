import test from 'node:test';
import assert from 'node:assert/strict';
import { latestApprovedApproval, orgBoundApproval } from '../src/domain/approval.js';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createJobRecord, getJobRecord, updateJob } from '../src/services/jobStore.js';

test('a later deployment rejection invalidates an earlier approval', () => {
  const job = { approvals: [
    { approvalType: 'DEPLOYMENT', validationId: 'validation-1', decision: 'APPROVED' },
    { approvalType: 'DEPLOYMENT', validationId: 'validation-1', decision: 'REJECTED' }
  ] };
  assert.equal(latestApprovedApproval(job, 'DEPLOYMENT', 'validation-1'), null);
});

test('approval decisions are isolated by validation ID', () => {
  const current = { approvalType: 'DEPLOYMENT', validationId: 'validation-2', decision: 'APPROVED' };
  const job = { approvals: [
    { approvalType: 'DEPLOYMENT', validationId: 'validation-1', decision: 'REJECTED' },
    current
  ] };
  assert.equal(latestApprovedApproval(job, 'DEPLOYMENT', 'validation-2'), current);
});

test('stale or mismatched implementation approval bindings reject without side effects', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const queued = [];
  const server = createApp({
    resolveSameOrg: async (input) => trustedContext(input.authenticatedOrgId),
    enqueue: async (message) => queued.push(message)
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `approval-mismatch-${Date.now()}`;
  await createApprovalReadyJob(jobId);
  const before = stableSnapshot(await getJobRecord(jobId));

  for (const body of [
    { planVersion: 2, planHash: 'plan-hash', scopeHash: 'scope-hash' },
    { planVersion: 1, planHash: 'wrong-plan', scopeHash: 'scope-hash' },
    { planVersion: 1, planHash: 'plan-hash', scopeHash: 'wrong-scope' }
  ]) {
    const response = await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
      method: 'POST',
      headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: true }),
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 409);
    assert.deepEqual(stableSnapshot(await getJobRecord(jobId)), before);
  }

  assert.deepEqual(queued, []);
});

test('implementation approval rejects empty evidence and components before side effects', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const queued = [];
  const server = createApp({
    resolveSameOrg: async (input) => trustedContext(input.authenticatedOrgId),
    enqueue: async (message) => queued.push(message)
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `approval-empty-evidence-${Date.now()}`;
  await createApprovalReadyJob(jobId, { plan: { ...plan(), evidenceIds: [], components: [] } });
  const before = stableSnapshot(await getJobRecord(jobId));

  const response = await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: true }),
    body: JSON.stringify({ planVersion: 1, planHash: 'plan-hash', scopeHash: 'scope-hash' })
  });

  assert.equal(response.status, 409);
  assert.deepEqual(stableSnapshot(await getJobRecord(jobId)), before);
  assert.deepEqual(queued, []);
});

test('valid same-org implementation approval succeeds with exact plan and scope hashes', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const queued = [];
  const server = createApp({
    resolveSameOrg: async (input) => trustedContext(input.authenticatedOrgId),
    enqueue: async (message) => queued.push(message)
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `approval-valid-${Date.now()}`;
  await createApprovalReadyJob(jobId);

  const response = await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: true, canDeploy: false }),
    body: JSON.stringify({ planVersion: 1, planHash: 'plan-hash', scopeHash: 'scope-hash' })
  });

  assert.equal(response.status, 201);
  const updated = await getJobRecord(jobId);
  assert.equal(updated.status, 'IMPLEMENTING');
  assert.equal(updated.approvals[0].planHash, 'plan-hash');
  assert.equal(updated.approvals[0].metadataScopeHash, 'scope-hash');
  assert.equal(updated.approvals[0].salesforceOrganizationId, ORG_ID);
  assert.deepEqual(queued.map((item) => item.action), ['implement']);
});

test('worker approval guard requires plan version hash and scope hash bindings', () => {
  const job = {
    source: 'salesforce-chat',
    orgId: ORG_ID,
    plan: { ...plan(), planHash: 'current-plan-hash', planVersion: 2 },
    metadataScope: { hash: 'scope-hash' },
    approvals: [{
      approvalType: 'IMPLEMENTATION',
      decision: 'APPROVED',
      planVersion: 1,
      planHash: 'current-plan-hash',
      metadataScopeHash: 'scope-hash',
      salesforceOrganizationId: ORG_ID
    }]
  };

  assert.throws(
    () => orgBoundApproval(job, 'IMPLEMENTATION', { orgContext: trustedContext(ORG_ID) }),
    /current implementation approval/
  );
});

async function createApprovalReadyJob(jobId, options = {}) {
  await createJobRecord({
    jobId,
    userId: USER_ID,
    orgId: ORG_ID,
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, {
    status: 'AWAITING_IMPLEMENTATION_APPROVAL',
    plan: options.plan || plan(),
    metadataScope: { hash: 'scope-hash' },
    orgContext: trustedContext(ORG_ID),
    workItems: []
  });
}

function plan() {
  return {
    planVersion: 1,
    planHash: 'plan-hash',
    materialChangeHash: 'scope-hash',
    scopeHash: 'scope-hash',
    requirement: 'Create a recurring donation installment Flow.',
    acceptanceCriteria: ['Only paid donations are numbered.'],
    assumptions: [],
    evidenceIds: ['evidence:relationship'],
    components: [{ operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Implement the requested behavior.' }],
    expectedBehavior: ['Paid donations are numbered.'],
    testingStrategy: ['Validate the Flow in the verified sandbox.'],
    risks: [],
    rollbackStrategy: 'Disable generated metadata before deployment.'
  };
}

function trustedContext(expectedOrgId) {
  return {
    orgRegistryId: 'providus_orgfarm_dev',
    expectedOrgId,
    environment: 'developer',
    salesforceAlias: 'orgfarm-dev'
  };
}

function salesforceHeaders({ authorization, canImplement = false, canDeploy = false } = {}) {
  return {
    ...(authorization ? { Authorization: authorization } : {}),
    'Content-Type': 'application/json',
    'X-Agent-Source': 'Salesforce-Apex',
    'X-Agent-Org-Id': ORG_ID,
    'X-Agent-User-Id': USER_ID,
    'X-Agent-Can-Implement': String(canImplement),
    'X-Agent-Can-Deploy': String(canDeploy)
  };
}

function stableSnapshot(job) {
  return {
    status: job.status,
    approvals: job.approvals,
    audit: job.audit,
    stateHistory: job.stateHistory,
    logs: job.logs,
    commands: job.commands,
    workItems: job.workItems,
    orgContext: job.orgContext
  };
}

const ORG_ID = '00Dg500000E07e9EAB';
const USER_ID = '005g5000009ImIkAAK';
