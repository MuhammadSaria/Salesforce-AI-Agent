import { overallSpecialistStatus } from './orchestrator.js';

export function publicJobSummary(job) {
  return {
    jobId: job.jobId,
    jiraIssueKey: job.jiraIssueKey || '',
    jiraSummary: job.jira?.summary || job.requirement?.summary || '',
    source: job.source || '',
    status: job.status,
    currentActivity: publicCurrentActivity(job),
    customerName: job.orgContext?.customerName || job.context?.customerName || '',
    targetOrgDisplayName: job.orgContext?.displayName || '',
    environment: job.orgContext?.environment || job.context?.environment || '',
    salesforceOrganizationId: job.orgContext?.expectedOrgId || '',
    planVersion: Number(job.plan?.planVersion || job.iteration || 1),
    specialistOverallStatus: overallSpecialistStatus(job.workItems || []),
    requiresAttention: ['AWAITING_ORG_SELECTION', 'AWAITING_REQUIREMENTS', 'AWAITING_PLAN_APPROVAL', 'VALIDATION_FAILED', 'AWAITING_DEPLOYMENT_APPROVAL', 'FAILED'].includes(job.status),
    createdAt: job.createdAt || '',
    updatedAt: job.updatedAt || ''
  };
}

export function publicCurrentActivity(job) {
  return job.status === 'ANALYZING_DEPENDENCIES' ? job.currentActivity || '' : '';
}

export function paginateJobSummaries(records, options = {}) {
  const limit = Math.min(100, Math.max(1, Number.parseInt(options.limit, 10) || 50));
  const sorted = [...(records || [])].sort((left, right) => {
    const timestampOrder = String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    return timestampOrder || String(right.jobId || '').localeCompare(String(left.jobId || ''));
  });
  const cursorJobId = decodeCursor(options.cursor);
  const cursorIndex = cursorJobId ? sorted.findIndex((job) => job.jobId === cursorJobId) : -1;
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  const selected = sorted.slice(start, start + limit);
  const hasMore = start + selected.length < sorted.length;
  return {
    jobs: selected.map(publicJobSummary),
    nextCursor: hasMore && selected.length ? encodeCursor(selected.at(-1).jobId) : null,
    total: sorted.length
  };
}

function encodeCursor(jobId) {
  return Buffer.from(String(jobId), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor || !/^[A-Za-z0-9_-]{1,400}$/.test(String(cursor))) return '';
  try {
    return Buffer.from(String(cursor), 'base64url').toString('utf8');
  } catch {
    return '';
  }
}
