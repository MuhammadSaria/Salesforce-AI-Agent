import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueueJobOptions, runtimeReadiness, shouldFinalizeQueueFailure, writeWorkerHeartbeat } from '../src/services/runtimeHealth.js';

test('queue jobs use bounded exponential retries', () => {
  assert.deepEqual(buildQueueJobOptions({ queueAttempts: 3, queueBackoffMs: 5000 }), {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: false,
    removeOnFail: false
  });
  assert.equal(shouldFinalizeQueueFailure(0, 3), false);
  assert.equal(shouldFinalizeQueueFailure(1, 3), false);
  assert.equal(shouldFinalizeQueueFailure(2, 3), true);
});

test('worker heartbeat is stored with a short expiry', async () => {
  const calls = [];
  const redisClient = { set: async (...args) => { calls.push(args); return 'OK'; } };
  await writeWorkerHeartbeat(redisClient, { now: new Date('2026-07-16T10:00:00Z'), ttlSeconds: 30 });

  assert.equal(calls[0][0], 'providus-nexus:worker:heartbeat');
  assert.equal(calls[0][2], 'EX');
  assert.equal(calls[0][3], 30);
  assert.doesNotMatch(calls[0][1], /token|password|redis:\/\//i);
});

test('Redis readiness requires both a connection and a fresh worker heartbeat', async () => {
  const configValue = {
    queueDriver: 'redis',
    jiraBaseUrl: 'https://example.atlassian.net',
    jiraEmail: 'developer@example.com',
    jiraApiToken: 'secret',
    jiraAgentAccountId: 'account-id',
    apiAuthToken: 'middleware-secret',
    agentBackend: 'codex'
  };
  const redisClient = { ping: async () => 'PONG', get: async () => JSON.stringify({ recordedAt: '2026-07-16T10:00:00.000Z' }) };
  const result = await runtimeReadiness({ redisClient, configValue, now: new Date('2026-07-16T10:00:10Z'), heartbeatMaxAgeMs: 30000 });

  assert.equal(result.ready, true);
  assert.deepEqual(result.checks, { queue: { ok: true }, worker: { ok: true }, jira: { ok: true }, authentication: { ok: true }, agentBackend: { ok: true } });
  assert.doesNotMatch(JSON.stringify(result), /secret|example\.atlassian|account-id/i);
});

test('readiness fails safely when the worker heartbeat is missing', async () => {
  const redisClient = { ping: async () => 'PONG', get: async () => null };
  const result = await runtimeReadiness({
    redisClient,
    configValue: { queueDriver: 'redis', jiraBaseUrl: 'x', jiraEmail: 'x', jiraApiToken: 'x', jiraAgentAccountId: 'x', apiAuthToken: 'x', agentBackend: 'codex' }
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.worker.ok, false);
});

test('memory queue mode is ready without a separate worker', async () => {
  const result = await runtimeReadiness({
    redisClient: null,
    configValue: { queueDriver: 'memory', jiraBaseUrl: 'x', jiraEmail: 'x', jiraApiToken: 'x', jiraAgentAccountId: 'x', apiAuthToken: 'x', agentBackend: 'disabled' }
  });
  assert.equal(result.checks.queue.ok, true);
  assert.equal(result.checks.worker.ok, true);
});
