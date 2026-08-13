import { Worker } from 'bullmq';
import { config } from './config.js';
import { AGENT_QUEUE_NAME } from './queue/agentQueue.js';
import { redisConnection } from './queue/connection.js';
import { logger } from './logger.js';
import { createPostgresJobStore, setDefaultJobStore, withJobStore } from './persistence/jobStore.js';
import { databasePool } from './persistence/database.js';
import { migrate } from './persistence/migrate.js';
import { JOB_STATES } from './domain/jobState.js';
import { processAgentJob } from './services/agent.js';

if (config.queueDriver !== 'redis' && process.env.NODE_ENV !== 'test') {
  logger.info('Worker is not needed when QUEUE_DRIVER=memory; jobs run in the API process.');
  process.exit(0);
}

if (!config.jiraEnabled) {
  logger.info('Jira worker actions are disabled because JIRA_ENABLED is not true.');
}

export async function startWorker(options = {}) {
  const pool = options.pool || databasePool();
  await migrate(pool);
  await pool.query('SELECT 1');
  const jobStore = options.jobStore || createPostgresJobStore({ pool });
  setDefaultJobStore(jobStore);

  const worker = new Worker(
    AGENT_QUEUE_NAME,
    async (queueJob) => withJobStore(jobStore, async () => {
      const record = await jobStore.get(queueJob.data.jobId);
    if (!record) {
      throw new Error(`Job record not found: ${queueJob.data.jobId}`);
    }

    try {
      await processAgentJob(queueJob.data, { jobStore });
    } catch (error) {
      await jobStore.appendLog(record.jobId, 'error', error.message);
      const current = await jobStore.get(record.jobId);
      if (![JOB_STATES.FAILED, JOB_STATES.CANCELLED, JOB_STATES.COMPLETED, JOB_STATES.VALIDATION_FAILED, JOB_STATES.ORG_VERIFICATION_FAILED].includes(current.status)) {
        await jobStore.transition(record.jobId, JOB_STATES.FAILED, { actor: 'worker', reason: 'Worker stage failed.', error: error.message });
      }
      throw error;
    }
    }),
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

  return { worker, pool, jobStore, close: async () => { await worker.close(); await pool.end(); } };
}

if (process.env.NODE_ENV !== 'test') {
  const runtime = await startWorker();
  process.on('SIGTERM', async () => {
    await runtime.close();
    process.exit(0);
  });
}
