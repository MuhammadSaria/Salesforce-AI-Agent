import { publicDevelopmentStatus } from '../domain/developmentJob.js';
import { overallSpecialistStatus } from './orchestrator.js';
import { humanizeValidationFailure } from '../utils/validationFailure.js';

export function publicJob(job) {
  const safe = { ...job };
  safe.statusLabel = publicDevelopmentStatus(job.status);
  safe.specialistOverallStatus = overallSpecialistStatus(job.workItems || []);
  safe.revisions = (job.revisions || []).map((revision) => ({
    revisionNumber: revision.revisionNumber,
    invalidatedAt: revision.invalidatedAt,
    invalidatedBy: revision.invalidatedBy,
    reason: revision.reason,
    orgDisplayName: revision.orgContext?.displayName || '',
    planVersion: revision.plan?.planVersion || revision.revisionNumber,
    implementationCompleted: Boolean(revision.implementation),
    validationStatus: revision.validation?.status || '',
    approvalsInvalidated: (revision.approvals || []).length
  }));
  safe.conversation = (job.conversation || []).map((entry) => ({
    conversationId: entry.conversationId || '',
    role: entry.role || 'user',
    kind: entry.kind || 'message',
    source: entry.source || '',
    text: entry.text || '',
    actor: entry.actor || '',
    timestamp: entry.timestamp || '',
    responseToMessageId: entry.responseToMessageId || ''
  }));
  if (safe.validation?.status === 'FAILED') {
    safe.validation = {
      ...safe.validation,
      failureReason: safe.validation.failureReason || humanizeValidationFailure(safe.validation.error || safe.error)
    };
  }
  delete safe.prompt;
  return safe;
}
