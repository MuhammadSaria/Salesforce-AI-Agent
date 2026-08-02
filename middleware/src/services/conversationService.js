import { nanoid } from 'nanoid';
import { JOB_STATES } from '../domain/jobState.js';

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
      await repository.appendConversation(job.jobId, {
        conversationId: messageId,
        role: 'user',
        kind: 'message',
        source: 'salesforce-chat',
        text,
        actor: actor.id
      });
      await repository.appendAudit(job.jobId, {
        actor: actor.id,
        action: 'CONVERSATION_MESSAGE_ADDED',
        result: 'accepted',
        safeMetadata: { messageLength: text.length, status: job.status }
      });
      await enqueue({ jobId: job.jobId, action: 'understand', actor: actor.id }, { jobId: `${job.jobId}:understand:${Date.now()}` });
      return { jobId: job.jobId, status: job.status, messageId, message: 'Message accepted.' };
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
