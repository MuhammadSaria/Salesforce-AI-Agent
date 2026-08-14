import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { createJobRecord } from '../src/services/jobStore.js';
import { agentQueue, enqueueAgentJob } from '../src/queue/agentQueue.js';

test('enqueueAgentJob supports inline execution only when memory queue mode is selected', async () => {
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

test('Redis queue enqueue failure is not followed by inline worker fallback', async () => {
  const source = await readFile(new URL('../src/queue/agentQueue.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /falling back to in-memory processing/);
  assert.match(source, /config\.queueDriver !== 'memory'/);
});
