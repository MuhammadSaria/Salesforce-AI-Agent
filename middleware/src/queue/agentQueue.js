import { Queue } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { redisConnection } from './connection.js';
import { processAgentJob } from '../services/agent.js';
import { appendLog, getJobRecord, transitionJob } from '../services/jobStore.js';
import { JOB_STATES } from '../domain/jobState.js';

export const AGENT_QUEUE_NAME = 'salesforce-agent-jobs';

export const agentQueue =
  config.queueDriver === 'redis'
    ? new Queue(AGENT_QUEUE_NAME, {
        connection: redisConnection,
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false
        }
      })
    : null;

export async function enqueueAgentJob(job, options = {}) {
  if (agentQueue) {
    return agentQueue.add('process-agent-job', job, options);
  }

  setImmediate(async () => {
    try {
      await processAgentJob(job);
    } catch (error) {
      await appendLog(job.jobId, 'error', error.message);
      const current = await getJobRecord(job.jobId);
      if (current && ![JOB_STATES.FAILED, JOB_STATES.CANCELLED, JOB_STATES.COMPLETED, JOB_STATES.VALIDATION_FAILED, JOB_STATES.ORG_VERIFICATION_FAILED].includes(current.status)) {
        await transitionJob(job.jobId, JOB_STATES.FAILED, { actor: 'worker', reason: 'In-memory worker stage failed.', error: error.message });
      }
      logger.error({ jobId: job.jobId, error }, 'In-memory agent job failed');
    }
  });
  return { id: options.jobId || job.jobId };
}
