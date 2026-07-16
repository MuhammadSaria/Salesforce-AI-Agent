import { Queue } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { redisConnection } from './connection.js';
import { processAgentJob } from '../services/agent.js';
import { appendLog, getJobRecord, transitionJob } from '../services/jobStore.js';
import { JOB_STATES } from '../domain/jobState.js';
import { buildQueueJobOptions } from '../services/runtimeHealth.js';

export const AGENT_QUEUE_NAME = 'salesforce-agent-jobs';

export const agentQueue =
  config.queueDriver === 'redis'
    ? new Queue(AGENT_QUEUE_NAME, {
        connection: redisConnection,
        defaultJobOptions: buildQueueJobOptions(config)
      })
    : null;

export async function enqueueAgentJob(job, options = {}) {
  if (agentQueue) {
    const safeOptions = options.jobId ? { ...options, jobId: safeQueueJobId(options.jobId) } : options;
    try {
      return await agentQueue.add('process-agent-job', job, safeOptions);
    } catch (error) {
      logger.error({ jobId: job.jobId, error: error.message }, 'BullMQ enqueue failed');
      throw Object.assign(new Error('The durable job queue is unavailable. Try again after middleware readiness is restored.'), { statusCode: 503, code: 'QUEUE_UNAVAILABLE' });
    }
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

export function safeQueueJobId(value) {
  const result = String(value || '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 240);
  if (!result) throw new Error('Queue job ID is required.');
  return result;
}
