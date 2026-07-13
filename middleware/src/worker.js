import { Worker } from 'bullmq';
import { config } from './config.js';
import { AGENT_QUEUE_NAME } from './queue/agentQueue.js';
import { redisConnection } from './queue/connection.js';
import { logger } from './logger.js';
import { appendLog, getJobRecord, transitionJob } from './services/jobStore.js';
import { JOB_STATES } from './domain/jobState.js';
import { processAgentJob } from './services/agent.js';

if (config.queueDriver !== 'redis') {
  logger.info('Worker is not needed when QUEUE_DRIVER=memory; jobs run in the API process.');
  process.exit(0);
}

const worker = new Worker(
  AGENT_QUEUE_NAME,
  async (queueJob) => {
    const record = await getJobRecord(queueJob.data.jobId);
    if (!record) {
      throw new Error(`Job record not found: ${queueJob.data.jobId}`);
    }

    try {
      await processAgentJob(queueJob.data);
    } catch (error) {
      await appendLog(record.jobId, 'error', error.message);
      const current = await getJobRecord(record.jobId);
      if (![JOB_STATES.FAILED, JOB_STATES.CANCELLED, JOB_STATES.COMPLETED, JOB_STATES.VALIDATION_FAILED, JOB_STATES.ORG_VERIFICATION_FAILED].includes(current.status)) {
        await transitionJob(record.jobId, JOB_STATES.FAILED, { actor: 'worker', reason: 'Worker stage failed.', error: error.message });
      }
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 2
  }
);

worker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Agent job completed');
});

worker.on('failed', (job, error) => {
  logger.error({ jobId: job?.id, error }, 'Agent job failed');
});

process.on('SIGTERM', async () => {
  await worker.close();
  process.exit(0);
});
