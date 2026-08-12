import test from 'node:test';
import assert from 'node:assert/strict';
import { latestApprovedApproval, orgBoundApproval } from '../src/domain/approval.js';
import { architecturePlanHashes } from '../src/domain/architecturePlan.js';
import { canonicalInspectionHash } from '../src/domain/inspection.js';
import { config } from '../src/config.js';
import { createApp, deliverPendingDispatches } from '../src/server.js';
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

  const current = (await getJobRecord(jobId)).plan;
  for (const body of [
    { planVersion: 2, planHash: current.planHash, scopeHash: current.scopeHash },
    { planVersion: 1, planHash: 'f'.repeat(64), scopeHash: current.scopeHash },
    { planVersion: 1, planHash: current.planHash, scopeHash: 'e'.repeat(64) }
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
    body: JSON.stringify({ planVersion: 1, planHash: (await getJobRecord(jobId)).plan.planHash, scopeHash: (await getJobRecord(jobId)).plan.scopeHash })
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
    body: JSON.stringify({ planVersion: 1, planHash: (await getJobRecord(jobId)).plan.planHash, scopeHash: (await getJobRecord(jobId)).plan.scopeHash })
  });

  assert.equal(response.status, 201);
  const updated = await getJobRecord(jobId);
  assert.equal(updated.status, 'IMPLEMENTING');
  assert.equal(updated.approvals[0].planHash, updated.plan.planHash);
  assert.equal(updated.approvals[0].metadataScopeHash, updated.plan.scopeHash);
  assert.equal(updated.approvals[0].salesforceOrganizationId, ORG_ID);
  assert.deepEqual(queued.map((item) => item.action), ['implement']);
});

test('implementation approval records durable dispatch before enqueue and retries idempotently', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  let fail = true;
  const queued = [];
  const server = createApp({
    resolveSameOrg: async (input) => trustedContext(input.authenticatedOrgId),
    enqueue: async (message, options) => {
      if (fail) throw new Error('queue unavailable');
      queued.push({ message, options });
    }
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `approval-outbox-${Date.now()}`;
  await createApprovalReadyJob(jobId);

  const approvalResponse = await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: true }),
    body: JSON.stringify({ planVersion: 1, planHash: (await getJobRecord(jobId)).plan.planHash, scopeHash: (await getJobRecord(jobId)).plan.scopeHash })
  });

  assert.equal(approvalResponse.status, 201);
  let updated = await getJobRecord(jobId);
  assert.equal(updated.status, 'IMPLEMENTING');
  assert.equal(updated.dispatches[0].status, 'PENDING');
  assert.equal(queued.length, 0);

  fail = false;
  await Promise.all([
    deliverPendingDispatches({ enqueue: async (message, options) => queued.push({ message, options }) }),
    deliverPendingDispatches({ enqueue: async (message, options) => queued.push({ message, options }) })
  ]);

  updated = await getJobRecord(jobId);
  assert.equal(updated.dispatches[0].status, 'DISPATCHED');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].options.jobId, updated.dispatches[0].dispatchKey);
});

test('stale approval racing with replan has zero mutation', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const queued = [];
  const server = createApp({
    resolveSameOrg: async (input) => trustedContext(input.authenticatedOrgId),
    enqueue: async (message) => queued.push(message)
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `approval-stale-replan-${Date.now()}`;
  await createApprovalReadyJob(jobId);
  const stale = await getJobRecord(jobId);
  await updateJob(jobId, { plan: { ...plan(), planVersion: 2 }, iteration: 2 });
  const before = stableSnapshot(await getJobRecord(jobId));

  const response = await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: true }),
    body: JSON.stringify({ planVersion: 1, planHash: stale.plan.planHash, scopeHash: stale.plan.scopeHash })
  });

  assert.equal(response.status, 409);
  assert.deepEqual(stableSnapshot(await getJobRecord(jobId)), before);
  assert.deepEqual(queued, []);
});

test('implementation approval recomputes hashes and rejects tampered stored hashes', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const queued = [];
  const server = createApp({
    resolveSameOrg: async (input) => trustedContext(input.authenticatedOrgId),
    enqueue: async (message) => queued.push(message)
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `approval-tampered-hash-${Date.now()}`;
  const tampered = { ...plan(), planHash: 'a'.repeat(64) };
  await createApprovalReadyJob(jobId, { plan: tampered });
  const canonical = architecturePlanHashes(tampered);

  const response = await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: true }),
    body: JSON.stringify({ planVersion: 1, planHash: canonical.planHash, scopeHash: canonical.scopeHash })
  });

  assert.equal(response.status, 409);
  assert.equal((await getJobRecord(jobId)).status, 'AWAITING_IMPLEMENTATION_APPROVAL');
  assert.deepEqual(queued, []);
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
  const currentInspection = inspection();
  const currentPlan = options.plan || plan(currentInspection);
  await createJobRecord({
    jobId,
    userId: USER_ID,
    orgId: ORG_ID,
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, {
    status: 'AWAITING_IMPLEMENTATION_APPROVAL',
    inspection: currentInspection,
    plan: currentPlan,
    metadataScope: { hash: currentPlan.scopeHash },
    orgContext: trustedContext(ORG_ID),
    workItems: []
  });
}

function plan(currentInspection = inspection()) {
  const core = {
    planVersion: 1,
    requirement: 'Create a recurring donation installment Flow.',
    acceptanceCriteria: ['Only paid donations are numbered.'],
    assumptions: [],
    evidenceIds: ['evidence:relationship'],
    components: [{ operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Implement the requested behavior.' }],
    expectedBehavior: ['Paid donations are numbered.'],
    testingStrategy: ['Validate the Flow in the verified sandbox.'],
    risks: [],
    rollbackStrategy: 'Disable generated metadata before deployment.',
    trustedBinding: { inspectionHash: currentInspection.hash, sourceOrgId: ORG_ID }
  };
  const hashes = architecturePlanHashes(core);
  return { ...core, planHash: hashes.planHash, scopeHash: hashes.scopeHash, materialChangeHash: hashes.scopeHash };
}

function inspection() {
  const body = {
    sourceOrgId: ORG_ID,
    evidence: [{ evidenceId: 'evidence:relationship', kind: 'RELATIONSHIP', objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', targetObjectApiName: 'GiftCommitment', componentType: 'CustomField', componentApiName: 'GiftTransaction.GiftCommitmentId', sourceOrgId: ORG_ID, active: true, observedAt: new Date().toISOString() }]
  };
  return { ...body, hash: canonicalInspectionHash(body) };
}

function trustedContext(expectedOrgId) {
  return {
    orgRegistryId: 'providus_orgfarm_dev',
    expectedOrgId,
    environment: 'developer',
    salesforceAlias: 'orgfarm-dev',
    verified: { organizationId: expectedOrgId, verifiedAt: new Date().toISOString() }
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
    orgContext: job.orgContext,
    dispatches: job.dispatches || []
  };
}

const ORG_ID = '00Dg500000E07e9EAB';
const USER_ID = '005g5000009ImIkAAK';
