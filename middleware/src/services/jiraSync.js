import { nanoid } from 'nanoid';
import { JOB_STATES } from '../domain/jobState.js';
import { addJiraComment, claimJiraComment, getJiraComments } from './jira.js';
import { appendAudit, appendConversation, getJobRecord, invalidateForPlanChange, updateJob } from './jobStore.js';
import { classifyJiraComment, fallbackJiraReply, isProvidusNexusComment } from './jiraCommunication.js';
import { generateJiraConversationReply } from './codexExecutor.js';

const REVISION_READY_STATES = new Set([
  JOB_STATES.AWAITING_PLAN_APPROVAL,
  JOB_STATES.PLAN_REJECTED,
  JOB_STATES.ORG_VERIFICATION_FAILED,
  JOB_STATES.VALIDATION_FAILED,
  JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL,
  JOB_STATES.COMPLETED,
  JOB_STATES.FAILED
]);
const TERMINAL_OR_DEPLOYING_STATES = new Set([JOB_STATES.DEPLOYING, JOB_STATES.CANCELLED]);

export async function syncJiraComments(job, actor = 'jira-sync') {
  if (!job.jiraIssueKey) return { added: 0, reanalysisRequired: false };
  const comments = await getJiraComments(job.jiraIssueKey);
  const candidates = selectNewUserComments(job, comments);
  const selection = [];
  for (const comment of candidates) {
    if (await claimJiraComment(job.jobId, comment.id)) selection.push(comment);
  }
  const jiraSync = { commentIds: comments.map((comment) => comment.id), syncedAt: new Date().toISOString() };
  if (!selection.length) {
    await updateJob(job.jobId, { jiraSync });
    return { added: 0, reanalysisRequired: shouldResumeReceivedRevision(job) };
  }

  const processed = [];
  for (const comment of selection) {
    const classification = classifyJiraComment(comment.body);
    const fallback = fallbackJiraReply(job, classification);
    const reply = await generateJiraConversationReply(job, comment.body, classification, fallback);
    await addJiraComment(job.jiraIssueKey, reply);
    processed.push({ comment, classification, reply });
  }
  const revisionComments = processed.filter((item) => item.classification.requiresPlanRevision);
  const instructions = [...(job.instructions || []), ...revisionComments.map(({ comment }) => ({
    instructionId: nanoid(),
    text: comment.body,
    actor: comment.authorAccountId || comment.authorDisplayName || 'jira-user',
    timestamp: comment.created || new Date().toISOString(),
    source: 'jira-comment',
    jiraCommentId: comment.id
  }))];
  await updateJob(job.jobId, { instructions, jiraSync });
  for (const { comment, classification, reply } of processed) {
    await appendConversation(job.jobId, {
      conversationId: comment.id,
      role: 'user',
      kind: 'jira-comment',
      source: 'jira-comment',
      text: comment.body,
      actor: comment.authorAccountId || comment.authorDisplayName || 'jira-user',
      timestamp: comment.created || new Date().toISOString()
    });
    await appendConversation(job.jobId, {
      conversationId: nanoid(),
      role: 'agent',
      kind: 'jira-reply',
      source: 'jira-comment',
      text: reply,
      actor: 'Providus Nexus',
      timestamp: new Date().toISOString(),
      responseToMessageId: comment.id
    });
    await appendAudit(job.jobId, {
      actor: 'Providus Nexus',
      action: 'JIRA_COMMENT_REPLIED',
      result: 'success',
      safeMetadata: { jiraCommentId: comment.id, intent: classification.intent, requiresPlanRevision: classification.requiresPlanRevision }
    });
  }
  await appendAudit(job.jobId, { actor, action: 'JIRA_COMMENTS_SYNCHRONIZED', result: 'accepted', safeMetadata: { commentIds: selection.map((comment) => comment.id), count: selection.length, revisionCount: revisionComments.length } });

  if (!revisionComments.length) return { added: selection.length, replied: processed.length, reanalysisRequired: shouldResumeReceivedRevision(job) };

  if (job.status === JOB_STATES.RECEIVED) return { added: selection.length, replied: processed.length, reanalysisRequired: true };
  if (REVISION_READY_STATES.has(job.status)) {
    await invalidateForPlanChange(job.jobId, actor, { instruction: revisionComments.map(({ comment }) => comment.body).join('\n') });
    return { added: selection.length, replied: processed.length, reanalysisRequired: true };
  }
  if (TERMINAL_OR_DEPLOYING_STATES.has(job.status)) {
    await updateJob(job.jobId, { followUpRequired: true });
    return { added: selection.length, replied: processed.length, reanalysisRequired: false };
  }
  await updateJob(job.jobId, { pendingRevision: true });
  return { added: selection.length, replied: processed.length, reanalysisRequired: false };
}

export function shouldResumeReceivedRevision(job) {
  return job.status === JOB_STATES.RECEIVED && Number(job.nextPlanVersion || 1) > 1;
}

export async function activatePendingJiraRevision(jobId, actor = 'jira-sync') {
  const job = await getJobRecord(jobId);
  if (!job?.pendingRevision || !REVISION_READY_STATES.has(job.status)) return false;
  await updateJob(jobId, { pendingRevision: false });
  const latestInstruction = (job.instructions || []).at(-1)?.text || '';
  await invalidateForPlanChange(jobId, actor, { instruction: latestInstruction });
  return true;
}

export function selectNewUserComments(job, comments) {
  const explicitIds = new Set(job.jiraSync?.commentIds || []);
  const legacyBodies = new Set(job.jira?.comments || []);
  const existingInstructionIds = new Set((job.instructions || []).map((item) => item.jiraCommentId).filter(Boolean));
  return comments.filter((comment) => {
    if (!comment.id || !comment.body || explicitIds.has(comment.id) || existingInstructionIds.has(comment.id)) return false;
    if (!job.jiraSync && legacyBodies.has(comment.body)) return false;
    return !isAgentGeneratedComment(comment.body);
  });
}

export function isAgentGeneratedComment(body) {
  return isProvidusNexusComment(body) || /^(AI agent plan ready for review\.|AI agent job\s+.+\s+completed(?:\.|\s)|AI agent job\s+.+\s+completed without deployment\.)/i.test(String(body || '').trim());
}
