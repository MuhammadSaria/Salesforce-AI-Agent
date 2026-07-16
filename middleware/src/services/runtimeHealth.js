import { config } from '../config.js';
import { redis } from '../queue/connection.js';

export const WORKER_HEARTBEAT_KEY = 'providus-nexus:worker:heartbeat';

export function buildQueueJobOptions(configValue = config) {
  return {
    attempts: Math.max(1, Number(configValue.queueAttempts || 3)),
    backoff: { type: 'exponential', delay: Math.max(100, Number(configValue.queueBackoffMs || 5000)) },
    removeOnComplete: false,
    removeOnFail: false
  };
}

export function shouldFinalizeQueueFailure(attemptsMade, configuredAttempts) {
  return Number(attemptsMade || 0) + 1 >= Math.max(1, Number(configuredAttempts || 1));
}

export async function writeWorkerHeartbeat(redisClient = redis, options = {}) {
  if (!redisClient) return false;
  const now = options.now instanceof Date ? options.now : new Date();
  const ttlSeconds = Math.max(10, Number(options.ttlSeconds || config.workerHeartbeatTtlSeconds || 30));
  await redisClient.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ recordedAt: now.toISOString() }), 'EX', ttlSeconds);
  return true;
}

export async function runtimeReadiness(options = {}) {
  const configValue = options.configValue || config;
  const redisClient = options.redisClient === undefined ? redis : options.redisClient;
  const now = options.now instanceof Date ? options.now : new Date();
  const heartbeatMaxAgeMs = Number(options.heartbeatMaxAgeMs || configValue.workerHeartbeatMaxAgeMs || 45000);
  let queueOk = configValue.queueDriver === 'memory';
  let workerOk = configValue.queueDriver === 'memory';

  if (configValue.queueDriver === 'redis' && redisClient) {
    try {
      queueOk = await redisClient.ping() === 'PONG';
      const heartbeat = JSON.parse(await redisClient.get(WORKER_HEARTBEAT_KEY) || 'null');
      const recordedAt = Date.parse(heartbeat?.recordedAt || '');
      workerOk = Number.isFinite(recordedAt) && now.getTime() - recordedAt <= heartbeatMaxAgeMs;
    } catch {
      queueOk = false;
      workerOk = false;
    }
  }

  const checks = {
    queue: { ok: queueOk },
    worker: { ok: workerOk },
    jira: { ok: Boolean(configValue.jiraBaseUrl && configValue.jiraEmail && configValue.jiraApiToken && configValue.jiraAgentAccountId) },
    authentication: { ok: Boolean(configValue.apiAuthToken) },
    agentBackend: { ok: configValue.agentBackend === 'codex' || (configValue.nodeEnv === 'test' && configValue.agentBackend === 'disabled') }
  };
  return { ready: Object.values(checks).every((check) => check.ok), checks };
}
