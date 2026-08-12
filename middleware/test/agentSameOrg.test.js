import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { architecturePlanHashes } from '../src/domain/architecturePlan.js';
import { canonicalInspectionHash } from '../src/domain/inspection.js';
import { processAgentJob, setSameOrgResolverForTest } from '../src/services/agent.js';
import { createJobRecord, getJobRecord, updateJob } from '../src/services/jobStore.js';
import { trustOrgContext } from '../src/services/orgContextTrust.js';

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
    ...implementationReadyPatch(),
    status: 'IMPLEMENTING',
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

test('worker implementation with missing approval org ID rejects with no persistent side effects', async (t) => {
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-same-org-'));
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId));
  t.after(() => setSameOrgResolverForTest(null));

  const jobId = `same-org-worker-zero-missing-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, implementationReadyPatch({
    approvals: [implementationApproval({ salesforceOrganizationId: '' })],
    orgContext: { orgRegistryId: 'forged', expectedOrgId: '00D000000000BAD', environment: 'sandbox', verified: true }
  }));
  const before = sideEffectSnapshot(await getJobRecord(jobId));

  await assert.rejects(
    processAgentJob({ jobId, action: 'implement', actor: '005g5000009ImIkAAK' }),
    /current implementation approval/
  );

  assert.deepEqual(sideEffectSnapshot(await getJobRecord(jobId)), before);
});

test('worker implementation with mismatched approval org ID rejects with no persistent side effects', async (t) => {
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-same-org-'));
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId));
  t.after(() => setSameOrgResolverForTest(null));

  const jobId = `same-org-worker-zero-mismatch-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, implementationReadyPatch({
    approvals: [implementationApproval({ salesforceOrganizationId: '00Dg500000E07fAEAR' })],
    orgContext: { orgRegistryId: 'forged', expectedOrgId: '00D000000000BAD', environment: 'sandbox', verified: true }
  }));
  const before = sideEffectSnapshot(await getJobRecord(jobId));

  await assert.rejects(
    processAgentJob({ jobId, action: 'implement', actor: '005g5000009ImIkAAK' }),
    /current implementation approval/
  );

  assert.deepEqual(sideEffectSnapshot(await getJobRecord(jobId)), before);
});

test('worker rejects invalid inspection evidence before implementation side effects', async (t) => {
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-same-org-'));
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId));
  t.after(() => setSameOrgResolverForTest(null));

  const corruptions = [
    { name: 'missing referenced evidence', inspection: { ...inspection(), evidence: [] } },
    { name: 'duplicate evidence', inspection: { ...inspection(), evidence: [inspection().evidence[0], inspection().evidence[0]] } },
    { name: 'unknown kind', inspection: { ...inspection(), evidence: [{ ...inspection().evidence[0], kind: 'SOURCE_FILE' }] } },
    { name: 'missing active', inspection: { ...inspection(), evidence: [{ ...inspection().evidence[0], active: undefined }] } },
    { name: 'stale observedAt', inspection: { ...inspection(), evidence: [{ ...inspection().evidence[0], observedAt: '2026-01-01T00:00:00.000Z' }] } },
    { name: 'future observedAt', inspection: { ...inspection(), evidence: [{ ...inspection().evidence[0], observedAt: '2999-01-01T00:00:00.000Z' }] } },
    { name: 'mixed org', inspection: { ...inspection(), evidence: [{ ...inspection().evidence[0], sourceOrgId: '00Dg500000E07fAEAR' }] } },
    { name: 'tampered inspection hash', inspection: { ...inspection(), hash: 'f'.repeat(64) } }
  ];

  for (const corruption of corruptions) {
    const jobId = `same-org-worker-inspection-${corruption.name.replace(/\s+/g, '-')}-${Date.now()}`;
    await createJobRecord({
      jobId,
      userId: '005g5000009ImIkAAK',
      orgId: '00Dg500000E07e9EAB',
      source: 'salesforce-chat',
      prompt: 'Create a Flow'
    });
    await updateJob(jobId, implementationReadyPatch({ inspection: corruption.inspection }));
    const before = sideEffectSnapshot(await getJobRecord(jobId));

    await assert.rejects(
      processAgentJob({ jobId, action: 'implement', actor: '005g5000009ImIkAAK' }),
      /current implementation approval|inspection|evidence/i,
      corruption.name
    );

    assert.deepEqual(sideEffectSnapshot(await getJobRecord(jobId)), before, corruption.name);
  }
});

test('worker validation with invalid approval binding rejects with no persistent side effects', async (t) => {
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-same-org-'));
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId));
  t.after(() => setSameOrgResolverForTest(null));

  const jobId = `same-org-worker-validation-zero-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, implementationReadyPatch({
    approvals: [implementationApproval({ salesforceOrganizationId: '00Dg500000E07fAEAR' })],
    orgContext: { orgRegistryId: 'forged', expectedOrgId: '00D000000000BAD', environment: 'sandbox', verified: true },
    implementation: { sourceHash: 'source-hash', changedFiles: [], workspaceClean: true }
  }));
  const before = sideEffectSnapshot(await getJobRecord(jobId));

  await assert.rejects(
    processAgentJob({ jobId, action: 'validate', actor: '005g5000009ImIkAAK' }),
    /current implementation approval/
  );

  assert.deepEqual(sideEffectSnapshot(await getJobRecord(jobId)), before);
});

test('deployment worker with invalid approval does not persist orgContext', async (t) => {
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-same-org-'));
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId));
  t.after(() => setSameOrgResolverForTest(null));

  const jobId = `same-org-worker-deploy-zero-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, deploymentReadyPatch({
    status: 'DEPLOYING',
    approvals: [deploymentApproval({ salesforceOrganizationId: '' })],
    orgContext: { orgRegistryId: 'forged', expectedOrgId: '00D000000000BAD', environment: 'sandbox', verified: true }
  }));
  const before = sideEffectSnapshot(await getJobRecord(jobId));

  await assert.rejects(
    processAgentJob({ jobId, action: 'deploy', actor: '005g5000009ImIkAAK' }),
    /current deployment approval/
  );

  assert.deepEqual(sideEffectSnapshot(await getJobRecord(jobId)), before);
});

test('worker same-org approval path persists trusted org context after approval guards pass', async (t) => {
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-same-org-'));
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId));
  t.after(() => setSameOrgResolverForTest(null));

  const jobId = `same-org-worker-valid-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, implementationReadyPatch({
    approvals: [implementationApproval({ salesforceOrganizationId: '00Dg500000E07e9EAB' })],
    orgContext: { orgRegistryId: 'forged', expectedOrgId: '00D000000000BAD', environment: 'sandbox', verified: true },
    implementation: { sourceHash: 'source-hash', changedFiles: [], workspaceClean: true }
  }));

  await assert.rejects(
    processAgentJob({ jobId, action: 'validate', actor: '005g5000009ImIkAAK' }),
    /clean|implementation|validation/i
  );

  const updated = await getJobRecord(jobId);
  assert.equal(updated.orgContext.orgRegistryId, 'providus_orgfarm_dev');
  assert.equal(updated.orgContext.expectedOrgId, '00Dg500000E07e9EAB');
});

function implementationReadyPatch(overrides = {}) {
  const currentInspection = overrides.inspection || inspection();
  const currentPlan = architecturePlan(currentInspection);
  return {
    status: 'IMPLEMENTING',
    inspection: currentInspection,
    plan: currentPlan,
    metadataScope: { hash: currentPlan.scopeHash },
    approvals: [implementationApproval({}, currentPlan)],
    orgContext: trustedContext('00Dg500000E07e9EAB'),
    ...overrides
  };
}

function deploymentReadyPatch(overrides = {}) {
  const currentInspection = overrides.inspection || inspection();
  const currentPlan = architecturePlan(currentInspection);
  return {
    ...implementationReadyPatch({ inspection: currentInspection }),
    status: 'AWAITING_DEPLOYMENT_APPROVAL',
    implementation: { approvalId: 'approval-1', sourceHash: 'source-hash', commitHash: 'commit-hash', changedFiles: [], workspacePath: 'implementation/project' },
    validation: {
      validationId: 'validation-1',
      targetOrgId: '00Dg500000E07e9EAB',
      status: 'PASSED',
      sourceHash: 'source-hash',
      commitHash: 'commit-hash',
      planHash: currentPlan.planHash,
      metadataScopeHash: currentPlan.scopeHash,
      packageHash: 'package-hash',
      expiryTimestamp: new Date(Date.now() + 60000).toISOString()
    },
    approvals: [implementationApproval({}, currentPlan), deploymentApproval({}, currentPlan)],
    ...overrides
  };
}

function implementationApproval(overrides = {}, currentPlan = architecturePlan()) {
  return {
    approvalId: 'approval-1',
    approvalType: 'IMPLEMENTATION',
    decision: 'APPROVED',
    planVersion: 1,
    planHash: currentPlan.planHash,
    metadataScopeHash: currentPlan.scopeHash,
    salesforceOrganizationId: '00Dg500000E07e9EAB',
    ...overrides
  };
}

function deploymentApproval(overrides = {}, currentPlan = architecturePlan()) {
  return {
    approvalId: 'approval-deploy-1',
    approvalType: 'DEPLOYMENT',
    decision: 'APPROVED',
    planHash: currentPlan.planHash,
    metadataScopeHash: currentPlan.scopeHash,
    validationId: 'validation-1',
    validatedSourceHash: 'source-hash',
    deploymentPackageHash: 'package-hash',
    salesforceOrganizationId: '00Dg500000E07e9EAB',
    ...overrides
  };
}

function architecturePlan(currentInspection = inspection()) {
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
    trustedBinding: { inspectionHash: currentInspection.hash, sourceOrgId: '00Dg500000E07e9EAB' },
    fileOperations: [],
    dataOperations: []
  };
  const hashes = architecturePlanHashes(core);
  return { ...core, planHash: hashes.planHash, scopeHash: hashes.scopeHash, materialChangeHash: hashes.scopeHash };
}

function inspection() {
  const body = {
    sourceOrgId: '00Dg500000E07e9EAB',
    evidence: [{
      evidenceId: 'evidence:relationship',
      kind: 'RELATIONSHIP',
      objectApiName: 'GiftTransaction',
      fieldApiName: 'GiftCommitmentId',
      targetObjectApiName: 'GiftCommitment',
      componentType: 'CustomField',
      componentApiName: 'GiftTransaction.GiftCommitmentId',
      sourceOrgId: '00Dg500000E07e9EAB',
      active: true,
      observedAt: new Date().toISOString()
    }]
  };
  return { ...body, hash: canonicalInspectionHash(body) };
}

function sideEffectSnapshot(job) {
  return {
    status: job.status,
    orgContext: job.orgContext,
    stateHistory: job.stateHistory,
    messages: job.specialistMessages,
    approvals: job.approvals,
    auditEvents: job.audit,
    logs: job.logs,
    workItems: job.workItems,
    commands: job.commands,
    queueCalls: []
  };
}

function trustedContext(expectedOrgId) {
  return trustOrgContext({
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
      environment: 'developer',
      verifiedAt: new Date().toISOString()
    }
  });
}
