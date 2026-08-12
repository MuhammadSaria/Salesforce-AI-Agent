import { nanoid } from 'nanoid';
import { JOB_STATES } from '../domain/jobState.js';
import { canonicalInspectionHash } from '../domain/inspection.js';

export function conversationService({ repository, enqueue }) {
  return {
    async start({ actor, prompt, orgId = '', context = {}, orgContext = null }) {
      const jobId = nanoid();
      const job = await repository.create({
        jobId,
        prompt,
        jiraIssueKey: '',
        source: 'salesforce-chat',
        orgId,
        userId: actor.id,
        context,
        orgContext
      });
      await repository.appendConversation(jobId, {
        role: 'user',
        kind: 'requirement',
        source: 'salesforce-chat',
        text: prompt,
        actor: actor.id
      });
      await repository.appendAudit(jobId, {
        actor: actor.id,
        action: 'CONVERSATION_STARTED',
        result: 'accepted',
        safeMetadata: { source: 'salesforce-chat', promptLength: prompt.length }
      });
      await enqueue({ jobId, action: 'understand', actor: actor.id }, { jobId: `${jobId}:understand:1` });
      return { jobId, status: job.status, message: 'Job accepted for supervised conversation.' };
    },

    async append({ job, actor, text }) {
      assertConversable(job);
      const messageId = nanoid();
      const clarification = currentClarificationBinding(job, actor);
      const kind = clarification ? 'clarification-response' : 'message';
      await repository.appendConversation(job.jobId, {
        conversationId: messageId,
        role: 'user',
        kind,
        source: 'salesforce-chat',
        text,
        actor: actor.id,
        ...clarification
      });
      await repository.appendAudit(job.jobId, {
        actor: actor.id,
        action: 'CONVERSATION_MESSAGE_ADDED',
        result: 'accepted',
        safeMetadata: { messageLength: text.length, status: job.status }
      });
      await enqueue({ jobId: job.jobId, action: 'understand', actor: actor.id }, { jobId: `${job.jobId}:understand:${Date.now()}` });
      return { jobId: job.jobId, status: job.status, messageId, message: clarification ? 'Clarification accepted.' : 'Message accepted.' };
    },

    async cancel({ job, actor, reason }) {
      if (job.status === JOB_STATES.CANCELLED) return { jobId: job.jobId, status: JOB_STATES.CANCELLED };
      await repository.transition(job.jobId, JOB_STATES.CANCELLED, {
        actor: actor.id,
        reason: reason || 'Cancelled by user.'
      });
      await repository.appendAudit(job.jobId, {
        actor: actor.id,
        action: 'CONVERSATION_CANCELLED',
        result: 'accepted',
        safeMetadata: {}
      });
      return { jobId: job.jobId, status: JOB_STATES.CANCELLED };
    }
  };
}

function assertConversable(job) {
  if ([JOB_STATES.CANCELLED, JOB_STATES.COMPLETED].includes(job.status)) {
    throw Object.assign(new Error('This job is closed and cannot receive new messages.'), { statusCode: 409 });
  }
}

function currentClarificationBinding(job, actor) {
  if (job.source !== 'salesforce-chat' || job.status !== JOB_STATES.AWAITING_CLARIFICATION) return null;
  const open = (job.clarifications || []).filter((item) => item.status === 'OPEN');
  if (open.length !== 1) throw Object.assign(new Error('A single current clarification question is required before accepting a clarification response.'), { statusCode: 409, code: 'CLARIFICATION_CONTEXT_INVALID' });
  const inspectionHash = canonicalInspectionHash(job.inspection);
  const clarification = open[0];
  if (clarification.inspectionHash !== inspectionHash) throw Object.assign(new Error('The clarification question is stale. Re-run planning before answering.'), { statusCode: 409, code: 'CLARIFICATION_CONTEXT_STALE' });
  if (Number(clarification.planVersion) !== Number(job.iteration || job.nextPlanVersion || 0)) throw Object.assign(new Error('The clarification question no longer matches the current plan version.'), { statusCode: 409, code: 'CLARIFICATION_CONTEXT_STALE' });
  if (actor?.orgId && job.orgId && actor.orgId !== job.orgId) throw Object.assign(new Error('Authenticated Salesforce org does not match this clarification.'), { statusCode: 409, code: 'CLARIFICATION_ORG_MISMATCH' });
  return {
    ambiguityId: clarification.ambiguityId,
    responseToInspectionHash: inspectionHash,
    responseToPlanVersion: Number(clarification.planVersion)
  };
}
