import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  assertDataExecutionAuthority,
  assertDeploymentAuthority,
  buildDataOperationApproval,
  buildDataPreview,
  buildDeploymentApproval,
  executeApprovedDataOperations,
  executeValidatedDeployment,
  hashDeploymentPackage,
  inspectValidatedArtifact,
  writeValidatedOperations
} from '../src/services/phase1Deployment.js';
import { buildSfCommandArgs } from '../src/services/sfExecutor.js';
import { config } from '../src/config.js';

const ORG = '00Dg500000E07e9EAB';
const OTHER_ORG = '00Dg500000E07fAEAR';
const NOW = '2026-08-14T12:00:00.000Z';
const FUTURE = '2026-08-14T12:30:00.000Z';
const PAST = '2026-08-14T11:59:00.000Z';
const H = Object.freeze({
  plan: '1'.repeat(64), scope: '2'.repeat(64), inspection: '3'.repeat(64),
  source: '4'.repeat(64), package: '5'.repeat(64), commit: '6'.repeat(40), baseline: '7'.repeat(40)
});

test('deployment requires a separate exact unexpired deployment approval', () => {
  const job = deploymentJob();
  job.approvals = job.approvals.filter((approval) => approval.approvalType !== 'DEPLOYMENT');
  assert.throws(() => assertDeploymentAuthority({ job, artifact: artifact(), now: NOW }), hasCode('DEPLOYMENT_APPROVAL_REQUIRED'));

  job.approvals = [{ ...buildDeploymentApproval(deploymentJob(), { approvalId: 'approval', actorId: '005-deployer', now: NOW }), expiresAt: PAST }];
  assert.throws(() => assertDeploymentAuthority({ job, artifact: artifact(), now: NOW }), hasCode('DEPLOYMENT_APPROVAL_EXPIRED'));
});

test('an exact deployment approval makes the validated artifact eligible', () => {
  const result = assertDeploymentAuthority({ job: deploymentJob(), artifact: artifact(), now: NOW });
  assert.equal(result.eligible, true);
  assert.equal(result.approvalId, 'deployment-approval');
});

test('a corrected artifact keeps the immutable original baseline while binding approval to its new source hash', () => {
  const job = deploymentJob();
  job.implementationBaseline.sourceHash = 'a'.repeat(64);
  job.approvals = [buildDeploymentApproval(job, { approvalId: 'corrected-approval', actorId: '005-deployer', now: NOW })];
  assert.equal(assertDeploymentAuthority({ job, artifact: artifact(), now: NOW }).approvalId, 'corrected-approval');
  assert.equal(job.implementationBaseline.baselineCommit, H.baseline);
});

test('deployment uses Salesforce quick deploy for the exact validation identity instead of rereading mutable source', () => {
  assert.deepEqual(buildSfCommandArgs('deployValidated', { validationId: '0Af000000000001AAA', targetOrg: 'trusted-alias' }), [
    'project', 'deploy', 'quick', '--job-id', '0Af000000000001AAA', '--target-org', 'trusted-alias', '--json'
  ]);
  const manifestRoot = join(config.workspaceRoot, 'jobs', 'write-job', 'manifest');
  const dryRun = buildSfCommandArgs('deployDryRun', {
    manifest: join(manifestRoot, 'package.xml'), preDestructiveChanges: join(manifestRoot, 'destructiveChangesPre.xml'), targetOrg: 'trusted-alias'
  });
  assert.deepEqual(dryRun.slice(-2), ['--pre-destructive-changes', join(manifestRoot, 'destructiveChangesPre.xml')]);
});

for (const [name, mutate] of [
  ['org', (job) => { job.orgId = OTHER_ORG; }],
  ['validationId', (job) => { job.validation.validationId = 'validation-2'; }],
  ['sourceHash', (job) => { job.validation.sourceHash = 'a'.repeat(64); }],
  ['packageHash', (job) => { job.validation.packageHash = 'a'.repeat(64); }],
  ['commitHash', (job) => { job.validation.commitHash = 'a'.repeat(40); }],
  ['baselineCommit', (job) => { job.implementationBaseline.baselineCommit = 'a'.repeat(40); }],
  ['planHash', (job) => { job.plan.planHash = 'a'.repeat(64); }],
  ['scopeHash', (job) => { job.metadataScope.hash = 'a'.repeat(64); }],
  ['inspectionHash', (job) => { job.inspection.hash = 'a'.repeat(64); }]
]) {
  test(`deployment rejects changed ${name} binding`, () => {
    const job = deploymentJob();
    mutate(job);
    assert.throws(() => assertDeploymentAuthority({ job, artifact: artifact(), now: NOW }), hasCode('STALE_DEPLOYMENT_AUTHORITY'));
  });
}

test('deployment rejects stale Task 9 validation, lost lease, dirty worktree, and unsuccessful or stale Salesforce validation', () => {
  for (const [jobPatch, artifactPatch, code] of [
    [{ sourceValidation: { ...deploymentJob().sourceValidation, status: 'FAILED' } }, {}, 'STALE_SOURCE_VALIDATION'],
    [{}, { componentLeaseOwned: false }, 'COMPONENT_LOCK_LOST'],
    [{}, { clean: false }, 'DEPLOYMENT_WORKTREE_DIRTY'],
    [{ validation: { ...deploymentJob().validation, status: 'FAILED' } }, {}, 'STALE_VALIDATION'],
    [{ validation: { ...deploymentJob().validation, expiryTimestamp: PAST } }, {}, 'STALE_VALIDATION']
  ]) {
    assert.throws(
      () => assertDeploymentAuthority({ job: { ...deploymentJob(), ...jobPatch }, artifact: { ...artifact(), ...artifactPatch }, now: NOW }),
      hasCode(code)
    );
  }
});

test('deployment rejects an artifact changed after validation or approval', () => {
  for (const artifactPatch of [
    { sourceHash: 'a'.repeat(64) },
    { packageHash: 'a'.repeat(64) },
    { commitHash: 'a'.repeat(40) },
    { baselineCommit: 'a'.repeat(40) }
  ]) {
    assert.throws(
      () => assertDeploymentAuthority({ job: deploymentJob(), artifact: { ...artifact(), ...artifactPatch }, now: NOW }),
      hasCode('STALE_DEPLOYMENT_ARTIFACT')
    );
  }
});

test('deployment rejects a filesystem Flow changed from Draft to Active after Task 9 validation', () => {
  assert.throws(
    () => assertDeploymentAuthority({ job: deploymentJob(), artifact: { ...artifact(), flowStatuses: ['Active'] }, now: NOW }),
    hasCode('FLOW_MUST_BE_INACTIVE')
  );
});

test('duplicate delivery after successful deployment is idempotent', () => {
  const job = deploymentJob();
  job.deployment = { status: 'SUCCEEDED', packageHash: H.package, commitHash: H.commit };
  assert.deepEqual(assertDeploymentAuthority({ job, artifact: artifact(), now: NOW }), { alreadyDeployed: true });
});

test('executor receives exactly one call only after atomic reload and two exact-artifact checks', async () => {
  const job = deploymentJob();
  const calls = [];
  const store = atomicStore(job);
  const result = await executeValidatedDeployment({
    jobStore: store, jobId: job.jobId, actor: '005-deployer',
    loadArtifact: async () => { calls.push('inspect'); return artifact(); },
    deploy: async ({ validationId, packageHash }) => { calls.push(`deploy:${validationId}:${packageHash}`); return { deploymentId: '0Af-validation', stdout: '{"status":0}' }; },
    now: () => NOW
  });
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(calls, ['inspect', 'inspect', `deploy:validation-1:${H.package}`]);
  assert.equal(store.record.deployment.approvalId, 'deployment-approval');
  assert.equal(store.record.deployment.validationId, 'validation-1');
});

test('one byte changed between reservation and executor call produces zero mutation calls', async () => {
  const job = deploymentJob();
  let inspections = 0;
  let deployCalls = 0;
  await assert.rejects(
    executeValidatedDeployment({
      jobStore: atomicStore(job), jobId: job.jobId, actor: '005-deployer',
      loadArtifact: async () => ({ ...artifact(), ...(++inspections === 2 ? { sourceHash: 'a'.repeat(64) } : {}) }),
      deploy: async () => { deployCalls += 1; }, now: () => NOW
    }),
    hasCode('STALE_DEPLOYMENT_ARTIFACT')
  );
  assert.equal(deployCalls, 0);
});

test('approval expiry racing deployment reservation produces zero executor calls', async () => {
  const job = deploymentJob();
  let clockCalls = 0;
  let deployCalls = 0;
  await assert.rejects(
    executeValidatedDeployment({
      jobStore: atomicStore(job), jobId: job.jobId, actor: '005-deployer', loadArtifact: async () => artifact(),
      deploy: async () => { deployCalls += 1; }, now: () => (++clockCalls < 3 ? NOW : FUTURE)
    }),
    (error) => ['DEPLOYMENT_APPROVAL_EXPIRED', 'STALE_VALIDATION'].includes(error.code)
  );
  assert.equal(deployCalls, 0);
});

test('duplicate worker delivery after persisted success performs no second executor call', async () => {
  const job = deploymentJob();
  job.deployment = { status: 'SUCCEEDED', packageHash: H.package, commitHash: H.commit, deploymentId: '0Af-existing' };
  let deployCalls = 0;
  const result = await executeValidatedDeployment({ jobStore: atomicStore(job), jobId: job.jobId, loadArtifact: async () => artifact(), deploy: async () => { deployCalls += 1; }, now: () => NOW });
  assert.equal(result.alreadyDeployed, true);
  assert.equal(deployCalls, 0);
});

test('uncertain quick-deploy outcome is never inferred from dry-run identity or replayed', async () => {
  const job = deploymentJob();
  job.deployment = {
    status: 'IN_PROGRESS', reservationId: 'reservation', approvalId: 'deployment-approval', validationId: 'validation-1',
    sourceHash: H.source, packageHash: H.package, commitHash: H.commit, targetOrgId: ORG
  };
  let deployCalls = 0;
  const store = atomicStore(job);
  await assert.rejects(
    executeValidatedDeployment({ jobStore: store, jobId: job.jobId, loadArtifact: async () => artifact(), deploy: async () => { deployCalls += 1; }, now: () => NOW }),
    hasCode('DEPLOYMENT_RECONCILIATION_REQUIRED')
  );
  assert.equal(store.record.deployment.status, 'IN_PROGRESS');
  assert.equal(deployCalls, 0);
});

test('package hash covers manifest and exact metadata bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'providus-package-'));
  const flowPath = 'force-app/main/default/flows/Assign_Installment.flow-meta.xml';
  const manifestPath = join(root, 'manifest', 'package.xml');
  try {
    await mkdir(join(root, 'force-app/main/default/flows'), { recursive: true });
    await mkdir(join(root, 'manifest'), { recursive: true });
    await writeFile(join(root, flowPath), '<Flow><status>Draft</status></Flow>', 'utf8');
    await writeFile(manifestPath, '<Package><types><name>Flow</name></types></Package>', 'utf8');
    const first = await hashDeploymentPackage({ projectRoot: root, manifestPath, sourcePaths: [flowPath] });
    await writeFile(join(root, flowPath), '<Flow><status>Draft</status></Flow>\n', 'utf8');
    const changedSource = await hashDeploymentPackage({ projectRoot: root, manifestPath, sourcePaths: [flowPath] });
    await writeFile(join(root, flowPath), '<Flow><status>Draft</status></Flow>', 'utf8');
    await writeFile(manifestPath, '<Package><types><name>Flow</name></types></Package>\n', 'utf8');
    const changedManifest = await hashDeploymentPackage({ projectRoot: root, manifestPath, sourcePaths: [flowPath] });
    assert.notEqual(first, changedSource);
    assert.notEqual(first, changedManifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact inspection binds an approved delete to absence instead of reading a removed file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'providus-delete-'));
  const flowPath = 'force-app/main/default/flows/Retired_Flow.flow-meta.xml';
  const manifestPath = join(root, 'manifest', 'package.xml');
  const operation = { operation: 'delete', metadataType: 'Flow', apiName: 'Retired_Flow', path: flowPath, content: '', reason: 'Approved retirement' };
  try {
    await mkdir(join(root, 'manifest'), { recursive: true });
    await writeFile(manifestPath, '<Package/>', 'utf8');
    const inspected = await inspectValidatedArtifact({
      projectRoot: root, manifestPath, operations: [operation], baselineCommit: H.baseline, componentLeaseOwned: true,
      runGitCommand: async (command) => command === 'status' ? ({ exitCode: 0, stdout: '' }) : ({ exitCode: 0, stdout: `${H.commit}\n` })
    });
    assert.equal(inspected.sourceHash, stableOperationHash(operation));
    assert.match(inspected.packageHash, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact inspection proves one changed source byte and Active Flow stale before executor use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'providus-artifact-'));
  const flowPath = 'force-app/main/default/flows/Assign_Installment.flow-meta.xml';
  const manifestPath = join(root, 'manifest', 'package.xml');
  const operation = { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', path: flowPath, content: draftFlow() };
  try {
    await mkdir(join(root, 'force-app/main/default/flows'), { recursive: true });
    await mkdir(join(root, 'manifest'), { recursive: true });
    await writeFile(join(root, flowPath), operation.content, 'utf8');
    await writeFile(manifestPath, '<Package/>', 'utf8');
    const cleanGit = async (command) => command === 'status'
      ? ({ exitCode: 0, stdout: '' })
      : ({ exitCode: 0, stdout: `${H.commit}\n` });
    const valid = await inspectValidatedArtifact({ projectRoot: root, manifestPath, operations: [operation], runGitCommand: cleanGit, baselineCommit: H.baseline, componentLeaseOwned: true });
    assert.equal(valid.flowStatuses[0], 'Draft');
    await writeFile(join(root, flowPath), operation.content.replace('Draft', 'Active'), 'utf8');
    const changed = await inspectValidatedArtifact({ projectRoot: root, manifestPath, operations: [operation], runGitCommand: cleanGit, baselineCommit: H.baseline, componentLeaseOwned: true });
    assert.notEqual(changed.sourceHash, valid.sourceHash);
    assert.equal(changed.flowStatuses[0], 'Active');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writes only current Task 9 operations and creates the immutable implementation commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'providus-write-'));
  const flowPath = 'force-app/main/default/flows/Assign_Installment.flow-meta.xml';
  const manifestPath = join(root, 'manifest', 'package.xml');
  const operation = { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', path: flowPath, content: draftFlow() };
  const calls = [];
  try {
    await mkdir(join(root, 'force-app/main/default/flows'), { recursive: true });
    await mkdir(join(root, 'manifest'), { recursive: true });
    await writeFile(manifestPath, '<Package/>', 'utf8');
    const result = await writeValidatedOperations({
      job: sourceWriteJob(operation), operations: [operation], projectRoot: root, manifestPath,
      assertLeaseOwned: async () => { calls.push('lease'); },
      runGitCommand: sourceWriteGit(calls, flowPath)
    });
    assert.equal(result.baselineCommit, H.baseline);
    assert.equal(result.commitHash, H.commit);
    assert.equal(result.sourceHash, stableOperationHash(operation));
    assert.match(result.packageHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.changedFiles, [flowPath]);
    assert.equal(result.sourceWritten, true);
    assert.deepEqual(calls, ['lease', 'status-before', 'head-before', 'lease', 'status-written', 'add', 'commit', 'status-after', 'head-after', 'lease']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a Task 11 corrected source set is recommitted from the prior implementation without changing the baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'providus-correction-write-'));
  const flowPath = 'force-app/main/default/flows/Assign_Installment.flow-meta.xml';
  const manifestPath = join(root, 'manifest', 'package.xml');
  const operation = { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', path: flowPath, content: `${draftFlow()}\n` };
  const job = sourceWriteJob(operation);
  job.status = 'VALIDATING';
  job.implementation = { baselineCommit: H.baseline, commitHash: H.commit };
  job.implementationBaseline.sourceHash = 'a'.repeat(64);
  const calls = [];
  try {
    await mkdir(join(root, 'force-app/main/default/flows'), { recursive: true });
    await mkdir(join(root, 'manifest'), { recursive: true });
    await writeFile(manifestPath, '<Package/>', 'utf8');
    const result = await writeValidatedOperations({
      job, operations: [operation], projectRoot: root, manifestPath,
      assertLeaseOwned: async () => { calls.push('lease'); },
      runGitCommand: sourceWriteGit(calls, flowPath, false, H.commit)
    });
    assert.equal(result.baselineCommit, H.baseline);
    assert.equal(result.commitHash, H.commit);
    assert.equal(result.sourceHash, stableOperationHash(operation));
    assert.equal(job.implementationBaseline.baselineCommit, H.baseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unexpected worktree mutation prevents the implementation commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'providus-write-'));
  const flowPath = 'force-app/main/default/flows/Assign_Installment.flow-meta.xml';
  const manifestPath = join(root, 'manifest', 'package.xml');
  const operation = { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', path: flowPath, content: draftFlow() };
  const calls = [];
  try {
    await mkdir(join(root, 'force-app/main/default/flows'), { recursive: true });
    await mkdir(join(root, 'manifest'), { recursive: true });
    await writeFile(manifestPath, '<Package/>', 'utf8');
    await assert.rejects(
      writeValidatedOperations({ job: sourceWriteJob(operation), operations: [operation], projectRoot: root, manifestPath, assertLeaseOwned: async () => {}, runGitCommand: sourceWriteGit(calls, flowPath, true) }),
      hasCode('DEPLOYMENT_WORKTREE_CONTAMINATED')
    );
    assert.equal(calls.includes('commit'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('data preview boundary is strictly more than ten records', () => {
  assert.equal(buildDataPreview(dataPreviewInput(10)).requiresApproval, false);
  assert.equal(buildDataPreview(dataPreviewInput(11)).requiresApproval, true);
});

test('data preview binds exact filter-or-IDs, estimated count, and Salesforce before values', () => {
  const first = buildDataPreview({ ...dataPreviewInput(11), beforeValues: [{ Id: '001000000000001AAA', Status__c: 'Pending' }] });
  const changed = buildDataPreview({ ...dataPreviewInput(11), beforeValues: [{ Id: '001000000000001AAA', Status__c: 'Paid' }] });
  assert.deepEqual(first.filterOrIds, first.recordIds);
  assert.equal(first.estimatedCount, 11);
  assert.match(first.beforeValuesHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.previewHash, changed.previewHash);
});

test('eleven records require a dedicated exact unexpired data approval', () => {
  const preview = buildDataPreview(dataPreviewInput(11));
  const base = dataJob(preview);
  for (const approvals of [
    [],
    [{ ...buildDataOperationApproval(base, preview, { approvalId: 'data', actorId: '005-admin', now: NOW }), expiresAt: PAST }],
    [{ ...buildDataOperationApproval(base, preview, { approvalId: 'data', actorId: '005-admin', now: NOW }), previewHash: 'a'.repeat(64) }],
    [{ ...buildDataOperationApproval(base, preview, { approvalId: 'data', actorId: '005-admin', now: NOW }), approvalType: 'DEPLOYMENT' }],
    [{ ...buildDataOperationApproval(base, preview, { approvalId: 'data', actorId: '005-admin', now: NOW }), salesforceOrganizationId: OTHER_ORG }]
  ]) {
    assert.throws(
      () => assertDataExecutionAuthority({ job: { ...base, approvals }, preview, actualPreview: preview, now: NOW }),
      (error) => error.code.startsWith('DATA_')
    );
  }
});

test('exact data approval authorizes the same eleven-record preview', () => {
  const preview = buildDataPreview(dataPreviewInput(11));
  const job = dataJob(preview);
  job.approvals = [buildDataOperationApproval(job, preview, { approvalId: 'data-approval', actorId: '005-admin', now: NOW })];
  assert.deepEqual(assertDataExecutionAuthority({ job, preview, actualPreview: preview, now: NOW }), { approved: true, approvalId: 'data-approval' });
});

test('data execution rejects preview growth from eight to eleven and a changed approved record set', () => {
  const preview8 = buildDataPreview(dataPreviewInput(8));
  const actual11 = buildDataPreview(dataPreviewInput(11));
  assert.throws(() => assertDataExecutionAuthority({ job: dataJob(preview8), preview: preview8, actualPreview: actual11, now: NOW }), hasCode('DATA_PREVIEW_STALE'));

  const preview11 = buildDataPreview(dataPreviewInput(11));
  const changed11 = buildDataPreview({ ...dataPreviewInput(11), recordIds: Array.from({ length: 11 }, (_, index) => `0010000000001${String(index + 20).padStart(2, '0')}AAA`) });
  const job = dataJob(preview11);
  job.approvals = [buildDataOperationApproval(job, preview11, { approvalId: 'data-approval', actorId: '005-admin', now: NOW })];
  assert.throws(() => assertDataExecutionAuthority({ job, preview: preview11, actualPreview: changed11, now: NOW }), hasCode('DATA_PREVIEW_STALE'));
});

test('missing, expired, or stale >10 data authority makes zero downstream mutation calls', async () => {
  const preview = buildDataPreview(dataPreviewInput(11));
  for (const setup of [
    (job) => job,
    (job) => ({ ...job, approvals: [{ ...buildDataOperationApproval(job, preview, { approvalId: 'data', actorId: '005-admin', now: NOW }), expiresAt: PAST }] }),
    (job) => ({ ...job, approvals: [buildDataOperationApproval(job, preview, { approvalId: 'data', actorId: '005-admin', now: NOW })], actual: buildDataPreview({ ...dataPreviewInput(11), recordIds: dataPreviewInput(11).recordIds.slice(1) }) })
  ]) {
    let mutationCalls = 0;
    const configured = setup(dataJob(preview));
    await assert.rejects(
      executeApprovedDataOperations({
        job: configured,
        preview,
        loadPreview: async () => configured.actual || preview,
        mutate: async () => { mutationCalls += 1; },
        operations: [{ operation: 'update' }],
        now: NOW
      }),
      (error) => error.code.startsWith('DATA_')
    );
    assert.equal(mutationCalls, 0);
  }
});

test('durable data reservation blocks duplicate delivery and uncertain post-mutation retry', async () => {
  const preview = buildDataPreview(dataPreviewInput(11));
  const job = dataJob(preview);
  job.approvals = [buildDataOperationApproval(job, preview, { approvalId: 'data-approval', actorId: '005-admin', now: NOW })];
  job.dataPreview = preview;
  const store = atomicStore(job);
  const update = store.updateAtomically.bind(store);
  let updates = 0;
  store.updateAtomically = async (...args) => {
    updates += 1;
    if (updates === 2) throw Object.assign(new Error('database unavailable after Salesforce response'), { code: 'DATABASE_UNAVAILABLE' });
    return update(...args);
  };
  let mutationCalls = 0;
  await assert.rejects(
    executeApprovedDataOperations({
      job, preview, operations: [{ operation: 'update' }], loadPreview: async () => preview,
      jobStore: store, mutate: async () => { mutationCalls += 1; return { recordId: preview.recordIds[0] }; }, now: NOW
    }),
    (error) => error.code === 'DATABASE_UNAVAILABLE'
  );
  assert.equal(mutationCalls, 1);
  assert.equal(store.record.deployment.status, 'RECONCILIATION_REQUIRED');
  await assert.rejects(
    executeApprovedDataOperations({
      job: store.record, preview, operations: [{ operation: 'update' }], loadPreview: async () => preview,
      jobStore: store, mutate: async () => { mutationCalls += 1; }, now: NOW
    }),
    hasCode('DATA_EXECUTION_RECONCILIATION_REQUIRED')
  );
  assert.equal(mutationCalls, 1);
});

function deploymentJob() {
  const job = {
    jobId: 'job-12', source: 'salesforce-chat', status: 'DEPLOYING', orgId: ORG,
    plan: { planVersion: 2, planHash: H.plan, scopeHash: H.scope, trustedBinding: { sourceOrgId: ORG, inspectionHash: H.inspection }, components: [{ metadataType: 'Flow', apiName: 'Assign_Installment' }] },
    metadataScope: { hash: H.scope }, inspection: { hash: H.inspection },
    sourceValidation: { status: 'PASSED', sourceHash: H.source, sourceOrgId: ORG, planHash: H.plan, scopeHash: H.scope, inspectionHash: H.inspection },
    implementationBaseline: { status: 'CAPTURED', baselineCommit: H.baseline, sourceHash: H.source, sourceOrgId: ORG, planHash: H.plan, scopeHash: H.scope, inspectionHash: H.inspection, componentKeys: ['Flow:Assign_Installment'] },
    implementation: { baselineCommit: H.baseline, sourceHash: H.source, packageHash: H.package, commitHash: H.commit, componentKeys: ['Flow:Assign_Installment'] },
    validation: { validationId: 'validation-1', status: 'PASSED', targetOrgId: ORG, sourceHash: H.source, packageHash: H.package, commitHash: H.commit, baselineCommit: H.baseline, planHash: H.plan, scopeHash: H.scope, inspectionHash: H.inspection, timestamp: NOW, expiryTimestamp: FUTURE },
    approvals: [], deployment: null
  };
  job.approvals = [{ ...buildDeploymentApproval(job, { approvalId: 'deployment-approval', actorId: '005-deployer', now: NOW }), expiresAt: FUTURE }];
  return job;
}

function artifact() {
  return { orgId: ORG, clean: true, componentLeaseOwned: true, baselineCommit: H.baseline, sourceHash: H.source, packageHash: H.package, commitHash: H.commit, flowStatuses: ['Draft'] };
}

function dataPreviewInput(count) {
  return {
    jobId: 'data-job', orgId: ORG, scopeHash: H.scope, operationId: 'update:Account:approved-selection',
    operation: 'update', objectApiName: 'Account', selectionIdentity: 'approved-selection',
    recordIds: Array.from({ length: count }, (_, index) => `0010000000000${String(index + 1).padStart(2, '0')}AAA`),
    fields: ['Status__c'], changeSummary: [{ field: 'Status__c', action: 'set approved value' }], expiresAt: FUTURE
  };
}

function dataJob(preview) {
  return { jobId: 'data-job', orgId: ORG, metadataScope: { hash: H.scope }, validation: { expiryTimestamp: FUTURE }, dataPreview: preview, approvals: [] };
}

function draftFlow() {
  return '<?xml version="1.0" encoding="UTF-8"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><status>Draft</status></Flow>';
}

function sourceWriteJob(operation) {
  const sourceHash = stableOperationHash(operation);
  return {
    jobId: 'write-job', status: 'IMPLEMENTING', orgId: ORG,
    plan: { planVersion: 2, planHash: H.plan, scopeHash: H.scope, trustedBinding: { sourceOrgId: ORG, inspectionHash: H.inspection }, components: [{ metadataType: 'Flow', apiName: 'Assign_Installment' }] },
    metadataScope: { hash: H.scope }, inspection: { hash: H.inspection }, specialistResults: { FLOW: { operations: [operation] } },
    sourceValidation: { status: 'PASSED', sourceHash, sourceOrgId: ORG, planHash: H.plan, scopeHash: H.scope, inspectionHash: H.inspection, operationCount: 1, validatedPaths: [operation.path] },
    implementationBaseline: { status: 'CAPTURED', baselineCommit: H.baseline, sourceHash, sourceOrgId: ORG, planHash: H.plan, scopeHash: H.scope, inspectionHash: H.inspection, componentKeys: ['Flow:Assign_Installment'], sourceWritten: false }
  };
}

function stableOperationHash(operation) {
  const keys = Object.keys(operation).sort();
  const body = `{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(operation[key])}`).join(',')}}`;
  return (awaitHash(`[${body}]`));
}

function awaitHash(value) {
  // Literal SHA-256 calculation independent of the production stableHash helper.
  return createHash('sha256').update(value).digest('hex');
}

function sourceWriteGit(calls, flowPath, contaminated = false, startingCommit = H.baseline) {
  let statusCall = 0;
  let headCall = 0;
  return async (command) => {
    if (command === 'status') {
      statusCall += 1;
      const name = statusCall === 1 ? 'status-before' : statusCall === 2 ? 'status-written' : 'status-after';
      calls.push(name);
      if (statusCall === 1) return { exitCode: 0, stdout: '' };
      if (statusCall === 2) return { exitCode: 0, stdout: contaminated ? ` M ${flowPath}\n?? debug.txt\n` : ` M ${flowPath}\n` };
      return { exitCode: 0, stdout: '' };
    }
    if (command === 'rev-parse') {
      headCall += 1;
      calls.push(headCall === 1 ? 'head-before' : 'head-after');
      return { exitCode: 0, stdout: `${headCall === 1 ? startingCommit : H.commit}\n` };
    }
    calls.push(command);
    return { exitCode: 0, stdout: '' };
  };
}

function atomicStore(job) {
  return {
    record: structuredClone(job),
    async get() { return structuredClone(this.record); },
    async updateAtomically(_jobId, operation) {
      const result = await operation(this.record);
      return structuredClone(result ?? this.record);
    }
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
