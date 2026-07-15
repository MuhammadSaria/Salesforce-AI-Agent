import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobRecord } from '../src/services/jobStore.js';
import { agentQueue, enqueueAgentJob } from '../src/queue/agentQueue.js';

test('enqueueAgentJob falls back to in-memory execution when BullMQ enqueue fails', async () => {
  if (!agentQueue) {
    assert.equal(typeof enqueueAgentJob, 'function');
    return;
  }

  const originalAdd = agentQueue.add.bind(agentQueue);
  agentQueue.add = async () => {
    throw new Error('redis unavailable');
  };

  try {
    const jobId = `queue-fallback-${Date.now()}`;
    await createJobRecord({ jobId, userId: 'test-user' });
    const result = await enqueueAgentJob({ jobId, action: 'analyze', actor: 'test-user' }, { jobId: `${jobId}:analyze:1` });
    assert.equal(result.id, `${jobId}:analyze:1`);
  } finally {
    agentQueue.add = originalAdd;
  }
});
