import { sameSalesforceId } from '../utils/salesforceId.js';

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
    ? approval?.planHash === job.plan?.planHash && Number(approval?.planVersion) === Number(job.plan?.planVersion)
    : approval?.planHash === job.plan?.planHash
      || (approvalType === 'IMPLEMENTATION' && approval?.materialChangeHash && approval.materialChangeHash === job.plan?.materialChangeHash);
  if (!approval || approval.decision !== 'APPROVED' || !planMatches || approval.metadataScopeHash !== job.metadataScope?.hash) throw approvalError();
  if (!sameSalesforceId(approval.salesforceOrganizationId, orgContext?.expectedOrgId)) throw approvalError();
  if (job.source === 'salesforce-chat') {
    if (!sameSalesforceId(job.orgId, orgContext?.expectedOrgId) || !sameSalesforceId(approval.salesforceOrganizationId, job.orgId)) throw approvalError();
  }
  if (approvalType === 'DEPLOYMENT') {
    if (!validation || approval.validationId !== validation.validationId) throw approvalError();
    if (approval.validatedSourceHash !== validation.sourceHash || approval.deploymentPackageHash !== validation.packageHash) throw approvalError();
    if (!sameSalesforceId(validation.targetOrgId, orgContext?.expectedOrgId)) throw approvalError();
    if (job.source === 'salesforce-chat' && !sameSalesforceId(validation.targetOrgId, job.orgId)) throw approvalError();
  }
  return approval;
}
