import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { processAgentJob, setSameOrgResolverForTest } from '../src/services/agent.js';
import { createJobRecord, getJobRecord, updateJob } from '../src/services/jobStore.js';

test('worker re-resolves direct Salesforce org context before validation execution', async (t) => {
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-same-org-'));
  const calls = [];
  setSameOrgResolverForTest(async ({ authenticatedOrgId, actorId }) => {
    calls.push({ authenticatedOrgId, actorId });
    return trustedContext(authenticatedOrgId);
  });
  t.after(() => setSameOrgResolverForTest(null));

  const jobId = `same-org-worker-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, {
    status: 'IMPLEMENTING',
    plan: { planVersion: 1, planHash: 'plan-hash', materialChangeHash: 'material-hash', fileOperations: [], dataOperations: [] },
    metadataScope: { hash: 'scope-hash' },
    approvals: [{
      approvalId: 'approval-1',
      approvalType: 'IMPLEMENTATION',
      decision: 'APPROVED',
      planHash: 'plan-hash',
      metadataScopeHash: 'scope-hash',
      salesforceOrganizationId: '00Dg500000E07e9EAB'
    }],
    orgContext: { orgRegistryId: 'forged', expectedOrgId: '00D000000000BAD', environment: 'sandbox', verified: true },
    implementation: { sourceHash: 'source-hash', changedFiles: [], workspaceClean: true }
  });

  await assert.rejects(
    processAgentJob({ jobId, action: 'validate', actor: '005g5000009ImIkAAK' }),
    /VALIDATION_FAILED|clean|state|validation/i
  );
  const updated = await getJobRecord(jobId);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { authenticatedOrgId: '00Dg500000E07e9EAB', actorId: '005g5000009ImIkAAK' });
  assert.equal(updated.orgContext.orgRegistryId, 'providus_orgfarm_dev');
  assert.equal(updated.orgContext.expectedOrgId, '00Dg500000E07e9EAB');
});

test('worker implementation does not treat generic admin actor strings as approval', async (t) => {
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-same-org-'));
  const calls = [];
  setSameOrgResolverForTest(async ({ authenticatedOrgId, actorId }) => {
    calls.push({ authenticatedOrgId, actorId });
    return trustedContext(authenticatedOrgId);
  });
  t.after(() => setSameOrgResolverForTest(null));

  const jobId = `same-org-worker-admin-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, {
    status: 'IMPLEMENTING',
    plan: { planVersion: 1, planHash: 'plan-hash', materialChangeHash: 'material-hash', fileOperations: [], dataOperations: [] },
    metadataScope: { hash: 'scope-hash' },
    approvals: [],
    orgContext: { orgRegistryId: 'forged', expectedOrgId: '00D000000000BAD', environment: 'sandbox', verified: true }
  });

  await assert.rejects(
    processAgentJob({ jobId, action: 'implement', actor: 'admin' }),
    /current implementation approval/
  );

  assert.deepEqual(calls, [{ authenticatedOrgId: '00Dg500000E07e9EAB', actorId: 'admin' }]);
});

test('worker rejects salesforce-chat implementation approval org mismatch', async (t) => {
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-same-org-'));
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId));
  t.after(() => setSameOrgResolverForTest(null));

  const jobId = `same-org-worker-approval-mismatch-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, {
    status: 'IMPLEMENTING',
    plan: { planVersion: 1, planHash: 'plan-hash', materialChangeHash: 'material-hash', fileOperations: [], dataOperations: [] },
    metadataScope: { hash: 'scope-hash' },
    approvals: [{
      approvalId: 'approval-1',
      approvalType: 'IMPLEMENTATION',
      decision: 'APPROVED',
      planHash: 'plan-hash',
      metadataScopeHash: 'scope-hash',
      salesforceOrganizationId: '00Dg500000E07fAEAR'
    }],
    orgContext: trustedContext('00Dg500000E07e9EAB')
  });
  const before = await getJobRecord(jobId);

  await assert.rejects(
    processAgentJob({ jobId, action: 'implement', actor: '005g5000009ImIkAAK' }),
    /approval org|current implementation approval|exact plan, scope, and org/i
  );
  const updated = await getJobRecord(jobId);
  assert.equal(updated.status, 'IMPLEMENTING');
  assert.deepEqual(updated.logs, before.logs);
  assert.equal(updated.implementation, undefined);
});

test('worker rejects salesforce-chat approval without org binding', async (t) => {
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-same-org-'));
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId));
  t.after(() => setSameOrgResolverForTest(null));

  const jobId = `same-org-worker-approval-missing-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, {
    status: 'IMPLEMENTING',
    plan: { planVersion: 1, planHash: 'plan-hash', materialChangeHash: 'material-hash', fileOperations: [], dataOperations: [] },
    metadataScope: { hash: 'scope-hash' },
    approvals: [{
      approvalId: 'approval-1',
      approvalType: 'IMPLEMENTATION',
      decision: 'APPROVED',
      planHash: 'plan-hash',
      metadataScopeHash: 'scope-hash'
    }],
    orgContext: trustedContext('00Dg500000E07e9EAB')
  });
  const before = await getJobRecord(jobId);

  await assert.rejects(
    processAgentJob({ jobId, action: 'implement', actor: '005g5000009ImIkAAK' }),
    /approval org|current implementation approval|exact plan, scope, and org/i
  );
  const updated = await getJobRecord(jobId);
  assert.equal(updated.status, 'IMPLEMENTING');
  assert.deepEqual(updated.logs, before.logs);
  assert.equal(updated.implementation, undefined);
});

function trustedContext(expectedOrgId) {
  return {
    orgRegistryId: 'providus_orgfarm_dev',
    salesforceAlias: 'orgfarm-dev',
    expectedOrgId,
    environment: 'developer',
    instanceUrl: 'https://orgfarm-9914d7f2f7-dev-ed.develop.my.salesforce.com',
    displayName: 'Providus Technology Developer Org',
    customerName: 'Providus Technology',
    deploymentPermission: 'allowed',
    dataMutationPermission: 'blocked',
    recordDeletionPermission: 'blocked',
    allowedDataObjects: [],
    restrictedDataObjects: ['User'],
    maximumDataOperations: 10,
    maximumDeleteOperations: 1,
    productionApprovalRequired: false,
    allowedOperations: ['read', 'retrieve', 'validate'],
    allowedMetadataTypes: ['Flow'],
    restrictedMetadataTypes: ['Profile'],
    verified: {
      organizationId: expectedOrgId,
      instanceUrl: 'https://orgfarm-9914d7f2f7-dev-ed.develop.my.salesforce.com',
      username: 'saria4505102.8535b64837ad@agentforce.com',
      connected: true,
      environment: 'developer'
    }
  };
}
