import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stableHash } from '../utils/hash.js';
import { isPathInside } from '../utils/paths.js';
import { sameSalesforceId } from '../utils/salesforceId.js';
import { canonicalMetadataPath } from '../domain/metadataPath.js';
import { parseMetadataXml } from '../specialists/metadataXml.js';
import { nanoid } from 'nanoid';

export function buildDeploymentApproval(job, { approvalId, actorId, now = new Date().toISOString() } = {}) {
  const validation = job?.validation;
  const baseline = job?.implementationBaseline;
  if (!validation || !successfulValidation(validation.status) || !isFuture(validation.expiryTimestamp, now)) throw deploymentError('STALE_VALIDATION', 'A current successful Salesforce validation is required before approval.');
  assertTask9Binding(job);
  if (baseline?.baselineCommit !== validation.baselineCommit
    || job?.implementation?.baselineCommit !== validation.baselineCommit
    || job?.implementation?.sourceHash !== validation.sourceHash
    || job?.implementation?.packageHash !== validation.packageHash
    || job?.implementation?.commitHash !== validation.commitHash) {
    throw deploymentError('STALE_DEPLOYMENT_AUTHORITY', 'Persisted implementation and validation bindings are not current.');
  }
  return {
    approvalId,
    jobId: job?.jobId,
    approvalType: 'DEPLOYMENT',
    decision: 'APPROVED',
    approverIdentity: actorId,
    approvalTimestamp: now,
    expiresAt: validation?.expiryTimestamp,
    salesforceOrganizationId: validation?.targetOrgId,
    sourceOrgId: baseline?.sourceOrgId,
    planVersion: job?.plan?.planVersion,
    planHash: job?.plan?.planHash,
    metadataScopeHash: job?.metadataScope?.hash || job?.plan?.scopeHash,
    inspectionHash: job?.inspection?.hash,
    baselineCommit: baseline?.baselineCommit,
    sourceHash: validation?.sourceHash,
    packageHash: validation?.packageHash,
    commitHash: validation?.commitHash,
    validatedSourceHash: validation?.sourceHash,
    deploymentPackageHash: validation?.packageHash,
    gitCommitHash: validation?.commitHash,
    validationId: validation?.validationId,
    validationTimestamp: validation?.timestamp
  };
}

export function assertDeploymentAuthority({ job, artifact, now = new Date().toISOString() } = {}) {
  if (job?.deployment?.status === 'SUCCEEDED') {
    if (job.deployment.packageHash === artifact?.packageHash && job.deployment.commitHash === artifact?.commitHash) return { alreadyDeployed: true };
    throw deploymentError('DUPLICATE_DEPLOYMENT_CONFLICT', 'A different artifact is already recorded as deployed.');
  }
  const validation = job?.validation;
  if (!validation || !successfulValidation(validation.status) || !isFuture(validation.expiryTimestamp, now)) {
    throw deploymentError('STALE_VALIDATION', 'A current successful Salesforce validation is required.');
  }
  if (artifact?.componentLeaseOwned !== true) throw deploymentError('COMPONENT_LOCK_LOST', 'Component lock ownership was lost.');
  if (artifact?.clean !== true) throw deploymentError('DEPLOYMENT_WORKTREE_DIRTY', 'The implementation worktree contains unexpected changes.');
  if (!Array.isArray(artifact.flowStatuses) || artifact.flowStatuses.some((status) => status !== 'Draft')) {
    throw deploymentError('FLOW_MUST_BE_INACTIVE', 'Every Flow in the validated package must remain Draft.');
  }
  const expected = deploymentBinding(job);
  if (!sameSalesforceId(job?.orgId, expected.orgId)
    || !sameSalesforceId(job?.plan?.trustedBinding?.sourceOrgId, expected.orgId)
    || job?.plan?.planHash !== expected.planHash
    || (job?.metadataScope?.hash || job?.plan?.scopeHash) !== expected.scopeHash
    || job?.inspection?.hash !== expected.inspectionHash
    || job?.implementationBaseline?.baselineCommit !== expected.baselineCommit
    || job?.implementation?.baselineCommit !== expected.baselineCommit
    || job?.implementation?.sourceHash !== expected.sourceHash
    || job?.implementation?.packageHash !== expected.packageHash
    || job?.implementation?.commitHash !== expected.commitHash) {
    throw deploymentError('STALE_DEPLOYMENT_AUTHORITY', 'Persisted deployment bindings are no longer current.');
  }
  assertTask9Binding(job);
  if (!sameSalesforceId(artifact?.orgId, expected.orgId)
    || artifact?.baselineCommit !== expected.baselineCommit
    || artifact?.sourceHash !== expected.sourceHash
    || artifact?.packageHash !== expected.packageHash
    || artifact?.commitHash !== expected.commitHash) {
    throw deploymentError('STALE_DEPLOYMENT_ARTIFACT', 'The deployable bytes no longer match the validated artifact.');
  }
  const approval = latestApproval(job?.approvals, 'DEPLOYMENT');
  if (!approval || approval.decision !== 'APPROVED') {
    throw deploymentError('DEPLOYMENT_APPROVAL_REQUIRED', 'A separate deployment approval is required.');
  }
  if (!isFuture(approval.expiresAt, now)) throw deploymentError('DEPLOYMENT_APPROVAL_EXPIRED', 'The deployment approval has expired.');
  if (!deploymentApprovalMatches(approval, job, expected)) {
    throw deploymentError('STALE_DEPLOYMENT_AUTHORITY', 'The deployment approval does not match the exact validated artifact.');
  }
  return { eligible: true, approvalId: approval.approvalId };
}

export async function executeValidatedDeployment({ jobStore, jobId, actor = 'system', loadArtifact, deploy, now = () => new Date().toISOString() } = {}) {
  if (!jobStore || typeof loadArtifact !== 'function' || typeof deploy !== 'function') throw deploymentError('DEPLOYMENT_DEPENDENCIES_INVALID', 'Trusted deployment dependencies are required.');
  let current = await jobStore.get(jobId);
  if (!current) throw deploymentError('DEPLOYMENT_JOB_REQUIRED', 'A persisted deployment job is required.');
  if (current.deployment?.status === 'IN_PROGRESS') {
    throw deploymentError('DEPLOYMENT_RECONCILIATION_REQUIRED', 'A prior quick-deploy attempt has an uncertain outcome and must be reconciled before retry.');
  }
  const firstArtifact = await loadArtifact(current);
  const initial = assertDeploymentAuthority({ job: current, artifact: firstArtifact, now: now() });
  if (initial.alreadyDeployed) return { ...current.deployment, alreadyDeployed: true };
  const reservationId = nanoid();
  const reservation = await jobStore.updateAtomically(jobId, (record) => {
    if (record.deployment?.status === 'IN_PROGRESS') throw deploymentError('DEPLOYMENT_IN_PROGRESS', 'This exact deployment is already in progress.');
    const authority = assertDeploymentAuthority({ job: record, artifact: firstArtifact, now: now() });
    if (authority.alreadyDeployed) return { alreadyDeployed: true, deployment: record.deployment };
    record.deployment = {
      status: 'IN_PROGRESS', reservationId, approvalId: authority.approvalId,
      validationId: record.validation.validationId, sourceHash: record.validation.sourceHash,
      packageHash: record.validation.packageHash, commitHash: record.validation.commitHash,
      targetOrgId: record.validation.targetOrgId, reservedAt: now(), reservedBy: actor
    };
    return { reservationId, approvalId: authority.approvalId };
  });
  if (reservation.alreadyDeployed) return { ...reservation.deployment, alreadyDeployed: true };
  current = await jobStore.get(jobId);
  const finalArtifact = await loadArtifact(current);
  try {
    assertDeploymentAuthority({ job: current, artifact: finalArtifact, now: now() });
  } catch (error) {
    await markDeploymentFailure(jobStore, jobId, reservationId, error, 'BLOCKED');
    throw error;
  }
  let result;
  try {
    result = await deploy({
      jobId, orgId: current.validation.targetOrgId, validationId: current.validation.validationId,
      sourceHash: current.validation.sourceHash, packageHash: current.validation.packageHash,
      commitHash: current.validation.commitHash, approvalId: reservation.approvalId, artifact: finalArtifact
    });
  } catch (error) {
    await markDeploymentFailure(jobStore, jobId, reservationId, error, 'FAILED');
    throw error;
  }
  return jobStore.updateAtomically(jobId, (record) => {
    if (record.deployment?.reservationId !== reservationId || record.deployment?.status !== 'IN_PROGRESS') throw deploymentError('DEPLOYMENT_RESERVATION_STALE', 'Deployment reservation authority was lost.');
    const completed = {
      ...record.deployment,
      status: 'SUCCEEDED',
      deploymentId: String(result?.deploymentId || ''),
      result: String(result?.stdout || ''),
      deployedAt: now()
    };
    record.deployment = completed;
    return completed;
  });
}

export async function hashDeploymentPackage({ projectRoot, manifestPath, sourcePaths, operations } = {}) {
  const root = resolve(String(projectRoot || ''));
  const entries = [{ path: 'manifest/package.xml', bytes: (await readFile(resolve(String(manifestPath || '')))).toString('hex') }];
  try {
    entries.push({ path: 'manifest/destructiveChangesPre.xml', bytes: (await readFile(join(dirname(resolve(String(manifestPath || ''))), 'destructiveChangesPre.xml'))).toString('hex') });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (Array.isArray(operations)) {
    for (const operation of normalizeValidatedOperations(operations)) {
      if (operation.operation === 'delete') entries.push({ path: operation.path, operation: 'delete' });
      else entries.push({ path: operation.path, operation: operation.operation, bytes: (await readFile(resolve(root, operation.path))).toString('hex') });
    }
  } else {
    for (const path of normalizeSourcePaths(sourcePaths)) {
      const target = resolve(root, path);
      if (!isPathInside(root, target)) throw deploymentError('DEPLOYMENT_PATH_INVALID', 'A deployment source path is outside the trusted worktree.');
      entries.push({ path, bytes: (await readFile(target)).toString('hex') });
    }
  }
  return stableHash(entries);
}

export async function inspectValidatedArtifact({ projectRoot, manifestPath, operations, runGitCommand, baselineCommit, componentLeaseOwned } = {}) {
  const root = resolve(String(projectRoot || ''));
  const currentOperations = [];
  const flowStatuses = [];
  for (const operation of normalizeValidatedOperations(operations)) {
    if (operation.operation === 'delete') {
      try {
        await readFile(resolve(root, operation.path));
        throw deploymentError('STALE_DEPLOYMENT_ARTIFACT', 'An approved deleted metadata file is present in the trusted worktree.');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      currentOperations.push(operation);
      continue;
    }
    const content = await readFile(resolve(root, operation.path), 'utf8');
    currentOperations.push({ ...operation, content });
    if (operation.metadataType === 'Flow') {
      const xml = parseMetadataXml(content, 'Flow');
      const statuses = xml.children(xml.root, 'status');
      flowStatuses.push(statuses.length === 1 ? statuses[0].text.trim() : '');
    }
  }
  const status = await runGitCommand('status', { cwd: root });
  const head = await runGitCommand('rev-parse', { ref: 'HEAD', cwd: root });
  return {
    clean: status?.exitCode === 0 && !String(status.stdout || '').trim(),
    commitHash: String(head?.stdout || '').trim(),
    baselineCommit,
    sourceHash: stableHash(currentOperations),
    packageHash: await hashDeploymentPackage({ projectRoot: root, manifestPath, operations: currentOperations }),
    flowStatuses,
    componentLeaseOwned: componentLeaseOwned === true
  };
}

export async function writeValidatedOperations({ job, operations, projectRoot, manifestPath, runGitCommand, assertLeaseOwned } = {}) {
  const root = resolve(String(projectRoot || ''));
  const validated = normalizeValidatedOperations(operations);
  assertSourceWriteBinding(job, validated);
  await assertLeaseOwned();
  const before = await runGitCommand('status', { cwd: root });
  const baselineHead = await runGitCommand('rev-parse', { ref: 'HEAD', cwd: root });
  if (before?.exitCode !== 0 || String(before.stdout || '').trim()) throw deploymentError('DEPLOYMENT_WORKTREE_DIRTY', 'The baseline worktree must be clean before validated source is written.');
  const expectedHead = job.status === 'VALIDATING' ? job.implementation?.commitHash : job.implementationBaseline.baselineCommit;
  if (String(baselineHead?.stdout || '').trim() !== expectedHead) throw deploymentError('STALE_DEPLOYMENT_AUTHORITY', 'The trusted implementation worktree commit is no longer current.');
  for (const operation of validated) {
    const target = resolve(root, operation.path);
    if (!isPathInside(root, target)) throw deploymentError('DEPLOYMENT_PATH_INVALID', 'A deployment source path is outside the trusted worktree.');
    if (operation.operation === 'delete') await rm(target, { force: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, operation.content, 'utf8');
    }
  }
  await assertLeaseOwned();
  const written = await runGitCommand('status', { cwd: root });
  const changedFiles = porcelainPaths(written?.stdout);
  const expectedFiles = validated.map((operation) => operation.path).sort();
  const expectedSet = new Set(expectedFiles);
  if (written?.exitCode !== 0 || changedFiles.some((path) => !expectedSet.has(path))) {
    throw deploymentError('DEPLOYMENT_WORKTREE_CONTAMINATED', 'The worktree contains changes outside the exact validated operation set.');
  }
  for (const operation of validated.filter((item) => item.metadataType === 'Flow' && item.operation !== 'delete')) {
    const xml = parseMetadataXml(await readFile(resolve(root, operation.path), 'utf8'), 'Flow');
    const statuses = xml.children(xml.root, 'status');
    if (statuses.length !== 1 || statuses[0].text.trim() !== 'Draft') throw deploymentError('FLOW_MUST_BE_INACTIVE', 'Every Flow in the package must remain Draft.');
  }
  const add = await runGitCommand('add', { paths: expectedFiles, cwd: root });
  if (add?.exitCode !== 0) throw deploymentError('IMPLEMENTATION_COMMIT_FAILED', 'The exact validated source could not be staged.');
  const commit = await runGitCommand('commit', { message: `Providus Nexus implementation ${job.jobId}`, allowEmpty: true, cwd: root });
  if (commit?.exitCode !== 0) throw deploymentError('IMPLEMENTATION_COMMIT_FAILED', 'The exact validated source could not be committed.');
  const after = await runGitCommand('status', { cwd: root });
  const head = await runGitCommand('rev-parse', { ref: 'HEAD', cwd: root });
  if (after?.exitCode !== 0 || String(after.stdout || '').trim()) throw deploymentError('DEPLOYMENT_WORKTREE_DIRTY', 'The implementation worktree is not clean after commit.');
  const commitHash = String(head?.stdout || '').trim();
  if (head?.exitCode !== 0 || !/^[a-f0-9]{40,64}$/i.test(commitHash)) throw deploymentError('IMPLEMENTATION_COMMIT_FAILED', 'The immutable implementation commit could not be identified.');
  await assertLeaseOwned();
  return {
    baselineCommit: job.implementationBaseline.baselineCommit,
    commitHash,
    sourceHash: stableHash(validated),
    packageHash: await hashDeploymentPackage({ projectRoot: root, manifestPath, operations: validated }),
    changedFiles: expectedFiles,
    sourceWritten: true,
    implementedAt: new Date().toISOString()
  };
}

export function buildDataPreview(input = {}) {
  const recordIds = [...new Set((input.recordIds || []).map(String))].sort();
  const fields = [...new Set((input.fields || []).map(String))].sort();
  const beforeValuesHash = stableHash(input.beforeValues || []);
  const projection = {
    jobId: String(input.jobId || ''),
    salesforceOrganizationId: String(input.orgId || ''),
    scopeHash: String(input.scopeHash || ''),
    operationId: String(input.operationId || ''),
    operation: String(input.operation || ''),
    objectApiName: String(input.objectApiName || ''),
    selectionIdentity: String(input.selectionIdentity || ''),
    recordIds,
    recordCount: recordIds.length,
    filterOrIds: recordIds,
    estimatedCount: recordIds.length,
    fields,
    beforeValuesHash,
    changeSummary: input.changeSummary || []
  };
  return { ...projection, previewHash: stableHash(projection), requiresApproval: recordIds.length > 10, expiresAt: input.expiresAt };
}

export function buildDataOperationApproval(job, preview, { approvalId, actorId, now = new Date().toISOString() } = {}) {
  return {
    approvalId,
    jobId: job?.jobId,
    approvalType: 'DATA_OPERATION',
    decision: 'APPROVED',
    approverIdentity: actorId,
    approvalTimestamp: now,
    expiresAt: preview?.expiresAt || job?.validation?.expiryTimestamp,
    salesforceOrganizationId: job?.orgId || job?.orgContext?.expectedOrgId,
    metadataScopeHash: job?.metadataScope?.hash,
    operationId: preview?.operationId,
    recordCount: preview?.recordCount,
    estimatedCount: preview?.estimatedCount,
    beforeValuesHash: preview?.beforeValuesHash,
    previewHash: preview?.previewHash
  };
}

export function assertDataExecutionAuthority({ job, preview, actualPreview, now = new Date().toISOString() } = {}) {
  const jobOrgId = job?.orgId || job?.orgContext?.expectedOrgId;
  if (!preview || !actualPreview || preview.previewHash !== actualPreview.previewHash || preview.recordCount !== actualPreview.recordCount) {
    throw dataError('DATA_PREVIEW_STALE', 'The affected Salesforce record set changed after preview.');
  }
  if (!sameSalesforceId(preview.salesforceOrganizationId, jobOrgId)
    || preview.jobId !== job?.jobId
    || preview.scopeHash !== job?.metadataScope?.hash) {
    throw dataError('DATA_PREVIEW_STALE', 'The data preview is not bound to the current job, scope, and org.');
  }
  if (actualPreview.recordCount <= 10) return { approved: true, approvalId: '' };
  const approval = latestApproval(job?.approvals, 'DATA_OPERATION');
  if (!approval || approval.decision !== 'APPROVED') throw dataError('DATA_APPROVAL_REQUIRED', 'A separate data-operation approval is required for more than ten records.');
  if (!isFuture(approval.expiresAt, now)) throw dataError('DATA_APPROVAL_EXPIRED', 'The data-operation approval has expired.');
  if (approval.jobId !== job.jobId
    || !sameSalesforceId(approval.salesforceOrganizationId, jobOrgId)
    || approval.metadataScopeHash !== job.metadataScope.hash
    || approval.operationId !== preview.operationId
    || Number(approval.recordCount) !== preview.recordCount
    || Number(approval.estimatedCount) !== preview.estimatedCount
    || approval.beforeValuesHash !== preview.beforeValuesHash
    || approval.previewHash !== preview.previewHash) {
    throw dataError('DATA_APPROVAL_STALE', 'The data-operation approval does not match the exact preview.');
  }
  return { approved: true, approvalId: approval.approvalId };
}

export async function executeApprovedDataOperations({ job, preview, operations, loadPreview, mutate, jobStore, jobId = job?.jobId, actor = 'system', now = new Date().toISOString() } = {}) {
  if (typeof loadPreview !== 'function' || typeof mutate !== 'function' || !Array.isArray(operations)) throw dataError('DATA_EXECUTION_INVALID', 'Trusted data execution dependencies are required.');
  const actualPreview = await loadPreview();
  if (!jobStore) {
    const authority = assertDataExecutionAuthority({ job, preview, actualPreview, now });
    const results = [];
    for (const operation of operations) results.push(await mutate(operation));
    return { authority, results };
  }
  const current = await jobStore.get(jobId);
  if (!current) throw dataError('DATA_EXECUTION_INVALID', 'A persisted data-operation job is required.');
  if (current.deployment?.status === 'SUCCEEDED' && current.deployment?.previewHash === actualPreview.previewHash) {
    return { authority: { approved: true, approvalId: current.deployment.approvalId || '' }, results: current.deployment.recordResults || [], alreadyExecuted: true };
  }
  if (current.deployment?.kind === 'DATA_OPERATION') throw dataError('DATA_EXECUTION_RECONCILIATION_REQUIRED', 'A prior data execution has an uncertain or failed outcome and must be reconciled before retry.');
  const reservationId = nanoid();
  const reservation = await jobStore.updateAtomically(jobId, (record) => {
    if (record.deployment?.kind === 'DATA_OPERATION') throw dataError('DATA_EXECUTION_RECONCILIATION_REQUIRED', 'A prior data execution has an uncertain or failed outcome and must be reconciled before retry.');
    const authority = assertDataExecutionAuthority({ job: record, preview: record.dataPreview, actualPreview, now });
    record.deployment = {
      status: 'IN_PROGRESS', kind: 'DATA_OPERATION', reservationId, previewHash: actualPreview.previewHash,
      approvalId: authority.approvalId, targetOrgId: actualPreview.salesforceOrganizationId,
      recordResults: [], reservedAt: now, reservedBy: actor
    };
    return { approvalId: authority.approvalId };
  });
  const results = [];
  try {
    for (const operation of operations) {
      const result = await mutate(operation);
      results.push(result);
      await jobStore.updateAtomically(jobId, (record) => {
        assertDataReservation(record, reservationId);
        record.deployment.recordResults = structuredClone(results);
      });
    }
    await jobStore.updateAtomically(jobId, (record) => {
      assertDataReservation(record, reservationId);
      record.deployment = { ...record.deployment, status: 'SUCCEEDED', executedAt: now };
    });
    return { authority: { approved: true, approvalId: reservation.approvalId }, results };
  } catch (error) {
    await jobStore.updateAtomically(jobId, (record) => {
      if (record.deployment?.reservationId !== reservationId || record.deployment?.status !== 'IN_PROGRESS') return;
      record.deployment = { ...record.deployment, status: record.deployment.recordResults?.length ? 'PARTIAL_FAILURE' : 'RECONCILIATION_REQUIRED', errorCode: safeErrorCode(error, 'DATA_EXECUTION_FAILED'), failedAt: now };
    }).catch(() => {});
    throw error;
  }
}

function assertTask9Binding(job) {
  const source = job?.sourceValidation;
  if (!source || source.status !== 'PASSED'
    || source.sourceHash !== job?.validation?.sourceHash
    || source.planHash !== job?.plan?.planHash
    || source.scopeHash !== (job?.metadataScope?.hash || job?.plan?.scopeHash)
    || source.inspectionHash !== job?.inspection?.hash
    || !sameSalesforceId(source.sourceOrgId, job?.orgId)) {
    throw deploymentError('STALE_SOURCE_VALIDATION', 'The Task 9 source validation is no longer current.');
  }
}

function assertSourceWriteBinding(job, operations) {
  const source = job?.sourceValidation;
  const baseline = job?.implementationBaseline;
  const operationPaths = operations.map((operation) => operation.path);
  const stored = Object.values(job?.specialistResults || {}).flatMap((result) => result?.operations || []);
  stored.sort((left, right) => `${left.metadataType}:${left.apiName}`.localeCompare(`${right.metadataType}:${right.apiName}`, 'en-US'));
  const initialWrite = job?.status === 'IMPLEMENTING';
  const correctionWrite = job?.status === 'VALIDATING'
    && job?.implementation?.baselineCommit === baseline?.baselineCommit
    && typeof job?.implementation?.commitHash === 'string';
  if ((!initialWrite && !correctionWrite)
    || source?.status !== 'PASSED'
    || source.sourceHash !== stableHash(operations)
    || source.sourceHash !== stableHash(stored)
    || Number(source.operationCount) !== operations.length
    || stableHash(source.validatedPaths || []) !== stableHash(operationPaths)
    || source.planHash !== job?.plan?.planHash
    || source.scopeHash !== (job?.metadataScope?.hash || job?.plan?.scopeHash)
    || source.inspectionHash !== job?.inspection?.hash
    || !sameSalesforceId(source.sourceOrgId, job?.orgId)
    || baseline?.status !== 'CAPTURED'
    || baseline.sourceWritten !== false
    || (initialWrite && baseline.sourceHash !== source.sourceHash)
    || baseline.planHash !== source.planHash
    || baseline.scopeHash !== source.scopeHash
    || baseline.inspectionHash !== source.inspectionHash
    || !sameSalesforceId(baseline.sourceOrgId, source.sourceOrgId)) {
    throw deploymentError('STALE_SOURCE_VALIDATION', 'The Task 9 validation and immutable baseline are not current for source writing.');
  }
}

function deploymentBinding(job) {
  const validation = job.validation;
  return {
    orgId: validation.targetOrgId,
    planVersion: job.plan?.planVersion,
    planHash: validation.planHash,
    scopeHash: validation.scopeHash || validation.metadataScopeHash,
    inspectionHash: validation.inspectionHash,
    baselineCommit: validation.baselineCommit,
    sourceHash: validation.sourceHash,
    packageHash: validation.packageHash,
    commitHash: validation.commitHash,
    validationId: validation.validationId,
    validationTimestamp: validation.timestamp
  };
}

function deploymentApprovalMatches(approval, job, expected) {
  return approval.jobId === job.jobId
    && sameSalesforceId(approval.salesforceOrganizationId, expected.orgId)
    && sameSalesforceId(approval.sourceOrgId, expected.orgId)
    && Number(approval.planVersion) === Number(expected.planVersion)
    && approval.planHash === expected.planHash
    && approval.metadataScopeHash === expected.scopeHash
    && approval.inspectionHash === expected.inspectionHash
    && approval.baselineCommit === expected.baselineCommit
    && approval.sourceHash === expected.sourceHash
    && approval.packageHash === expected.packageHash
    && approval.commitHash === expected.commitHash
    && approval.validationId === expected.validationId
    && approval.validationTimestamp === expected.validationTimestamp;
}

function normalizeOperations(operations) {
  if (!Array.isArray(operations) || !operations.length) throw deploymentError('DEPLOYMENT_OPERATIONS_INVALID', 'Validated deployment operations are required.');
  return operations.map((operation) => {
    const path = canonicalMetadataPath(operation.metadataType, operation.apiName);
    if (path !== operation.path) throw deploymentError('DEPLOYMENT_PATH_INVALID', 'A deployment operation path is not canonical.');
    return { operation: operation.operation, metadataType: operation.metadataType, apiName: operation.apiName, path };
  }).sort((left, right) => `${left.operation}:${left.metadataType}:${left.apiName}`.localeCompare(`${right.operation}:${right.metadataType}:${right.apiName}`, 'en-US'));
}

function normalizeValidatedOperations(operations) {
  return normalizeOperations(operations).map((normalized) => {
    const original = operations.find((operation) => operation.metadataType === normalized.metadataType && operation.apiName === normalized.apiName);
    if (normalized.operation !== 'delete' && (typeof original?.content !== 'string' || !original.content)) throw deploymentError('DEPLOYMENT_OPERATIONS_INVALID', 'Validated deployment source content is required.');
    return { ...original, path: normalized.path };
  });
}

function porcelainPaths(stdout) {
  if (!String(stdout || '').trim()) return [];
  return String(stdout).trimEnd().split(/\r?\n/).map((line) => {
    if (line.length < 4 || line.includes(' -> ') || line[2] !== ' ') throw deploymentError('DEPLOYMENT_WORKTREE_CONTAMINATED', 'The worktree contains an unsupported change.');
    return line.slice(3).replace(/^"|"$/g, '');
  }).sort();
}

function normalizeSourcePaths(paths) {
  return [...new Set((paths || []).map(String))].sort();
}

function latestApproval(approvals, type) {
  return [...(approvals || [])].reverse().find((approval) => approval.approvalType === type) || null;
}

function isFuture(value, now) {
  const expiry = Date.parse(String(value || ''));
  const current = Date.parse(String(now || ''));
  return Number.isFinite(expiry) && Number.isFinite(current) && expiry > current;
}

function deploymentError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function successfulValidation(status) {
  return status === 'PASSED' || status === 'SUCCEEDED';
}

function dataError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function assertDataReservation(record, reservationId) {
  if (record.deployment?.status !== 'IN_PROGRESS' || record.deployment?.reservationId !== reservationId) {
    throw dataError('DATA_EXECUTION_RECONCILIATION_REQUIRED', 'Data execution reservation authority was lost. Reconcile before retry.');
  }
}

function safeErrorCode(error, fallback) {
  return /^[A-Z0-9_]+$/.test(String(error?.code || '')) ? error.code : fallback;
}

async function markDeploymentFailure(jobStore, jobId, reservationId, error, status) {
  await jobStore.updateAtomically(jobId, (record) => {
    if (record.deployment?.reservationId !== reservationId || record.deployment?.status !== 'IN_PROGRESS') return record.deployment;
    record.deployment = {
      ...record.deployment,
      status,
      errorCode: /^[A-Z0-9_]+$/.test(String(error?.code || '')) ? error.code : 'DEPLOYMENT_FAILED',
      failedAt: new Date().toISOString()
    };
    return record.deployment;
  });
}
