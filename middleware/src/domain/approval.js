export function latestApproval(job, approvalType, validationId = '') {
  return [...(job.approvals || [])].reverse().find((approval) =>
    approval.approvalType === approvalType && (!validationId || approval.validationId === validationId)
  ) || null;
}

export function latestApprovedApproval(job, approvalType, validationId = '') {
  const approval = latestApproval(job, approvalType, validationId);
  return approval?.decision === 'APPROVED' ? approval : null;
}
