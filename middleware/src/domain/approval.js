import { sameSalesforceId } from '../utils/salesforceId.js';
import { architecturePlanHashes } from './architecturePlan.js';
import { canonicalInspectionHash, parseVerifiedInspection } from './inspection.js';

const SHA256 = /^[a-f0-9]{64}$/;

export function latestApproval(job, approvalType, validationId = '') {
  return [...(job.approvals || [])].reverse().find((approval) =>
    approval.approvalType === approvalType && (!validationId || approval.validationId === validationId)
  ) || null;
}

export function latestApprovedApproval(job, approvalType, validationId = '') {
  const approval = latestApproval(job, approvalType, validationId);
  return approval?.decision === 'APPROVED' ? approval : null;
}

export function orgBoundApproval(job, approvalType, options = {}) {
  const validationId = approvalType === 'DEPLOYMENT' ? job.validation?.validationId : '';
  const approval = options.approval || latestApprovedApproval(job, approvalType, validationId);
  const orgContext = options.orgContext || job.orgContext;
  const validation = options.validation || job.validation;
  const approvalError = () => Object.assign(new Error(`A current ${approvalType.toLowerCase()} approval for this exact plan, scope, and org is required.`), {
    statusCode: 409,
    code: 'APPROVAL_REQUIRED'
  });

  const planMatches = approvalType === 'IMPLEMENTATION' && job.source === 'salesforce-chat'
    ? implementationApprovalHashesMatch(job, approval)
    : approval?.planHash === job.plan?.planHash
      || (approvalType === 'IMPLEMENTATION' && approval?.materialChangeHash && approval.materialChangeHash === job.plan?.materialChangeHash);
  if (!approval || approval.decision !== 'APPROVED' || !planMatches || approval.metadataScopeHash !== job.metadataScope?.hash) throw approvalError();
  if (!sameSalesforceId(approval.salesforceOrganizationId, orgContext?.expectedOrgId)) throw approvalError();
  if (job.source === 'salesforce-chat') {
    if (!sameSalesforceId(job.orgId, orgContext?.expectedOrgId) || !sameSalesforceId(approval.salesforceOrganizationId, job.orgId)) throw approvalError();
    if (approvalType === 'IMPLEMENTATION') assertPlanInspectionBinding(job, orgContext);
  }
  if (approvalType === 'DEPLOYMENT') {
    if (!validation || approval.validationId !== validation.validationId) throw approvalError();
    if (approval.jobId !== job.jobId
      || !sameSalesforceId(approval.sourceOrgId, orgContext?.expectedOrgId)
      || approval.sourceHash !== validation.sourceHash
      || approval.packageHash !== validation.packageHash
      || approval.commitHash !== validation.commitHash
      || approval.baselineCommit !== validation.baselineCommit
      || approval.inspectionHash !== validation.inspectionHash
      || Number(approval.planVersion) !== Number(job.plan?.planVersion)
      || approval.validationTimestamp !== validation.timestamp
      || approval.expiresAt !== validation.expiryTimestamp
      || !futureTimestamp(approval.expiresAt)) throw approvalError();
    if (!sameSalesforceId(validation.targetOrgId, orgContext?.expectedOrgId)) throw approvalError();
    if (job.source === 'salesforce-chat' && !sameSalesforceId(validation.targetOrgId, job.orgId)) throw approvalError();
  }
  return approval;
}

export function assertCurrentImplementationApprovalBinding(job, submitted = {}, orgContext = job.orgContext) {
  const approvalError = (message = 'A current implementation approval for this exact plan, scope, and org is required.') => Object.assign(new Error(message), {
    statusCode: 409,
    code: 'APPROVAL_REQUIRED'
  });
  const version = Number(submitted.planVersion);
  if (!Number.isInteger(version) || version <= 0 || version !== Number(job.plan?.planVersion)) throw approvalError('Approval must identify the current positive plan version.');
  if (!SHA256.test(String(submitted.planHash || '')) || !SHA256.test(String(submitted.scopeHash || ''))) throw approvalError('Approval must identify canonical plan and scope hashes.');
  const hashes = recomputedImplementationHashes(job);
  if (submitted.planHash !== hashes.planHash || submitted.scopeHash !== hashes.scopeHash) throw approvalError();
  if (job.plan?.planHash !== hashes.planHash || (job.metadataScope?.hash || job.plan?.scopeHash) !== hashes.scopeHash) throw approvalError();
  assertPlanInspectionBinding(job, orgContext);
  return hashes;
}

export function recomputedImplementationHashes(job) {
  if (!job?.plan) throw Object.assign(new Error('A current implementation approval for this exact plan, scope, and org is required.'), { statusCode: 409, code: 'APPROVAL_REQUIRED' });
  return architecturePlanHashes(job.plan);
}

export function assertPlanInspectionBinding(job, orgContext = job.orgContext) {
  const binding = job.plan?.trustedBinding;
  const expectedOrgId = orgContext?.expectedOrgId;
  const inspection = job.inspection;
  const fail = () => Object.assign(new Error('A current implementation approval for this exact plan, scope, and org is required.'), {
    statusCode: 409,
    code: 'APPROVAL_REQUIRED'
  });
  if (!binding?.inspectionHash || !binding?.sourceOrgId || !sameSalesforceId(binding.sourceOrgId, expectedOrgId)) throw fail();
  let parsedInspection;
  try {
    parsedInspection = parseVerifiedInspection(inspection, { orgContext });
  } catch {
    throw fail();
  }
  if (canonicalInspectionHash(parsedInspection) !== binding.inspectionHash || !sameSalesforceId(parsedInspection.sourceOrgId, expectedOrgId)) throw fail();
  const evidence = new Map((inspection.evidence || []).map((item) => [item.evidenceId, item]));
  const seen = new Set();
  for (const id of job.plan.evidenceIds || []) {
    if (seen.has(id)) throw fail();
    seen.add(id);
    const item = evidence.get(id);
    if (!item || item.stale === true || item.active === false || !sameSalesforceId(item.sourceOrgId, expectedOrgId)) throw fail();
  }
}

function implementationApprovalHashesMatch(job, approval) {
  if (!approval || !Number.isInteger(Number(job.plan?.planVersion)) || Number(job.plan?.planVersion) <= 0) return false;
  if (Number(approval.planVersion) !== Number(job.plan?.planVersion)) return false;
  try {
    const hashes = recomputedImplementationHashes(job);
    return approval.planHash === hashes.planHash
      && approval.metadataScopeHash === hashes.scopeHash
      && job.plan.planHash === hashes.planHash
      && (job.metadataScope?.hash || job.plan?.scopeHash) === hashes.scopeHash;
  } catch {
    return false;
  }
}

function futureTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && timestamp > Date.now();
}
