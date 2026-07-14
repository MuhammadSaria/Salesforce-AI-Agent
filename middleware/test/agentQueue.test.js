import test from 'node:test';
import assert from 'node:assert/strict';
import { safeQueueJobId } from '../src/queue/agentQueue.js';

test('queue IDs remove BullMQ-reserved timestamp separators', () => {
  assert.equal(
    safeQueueJobId('job-1:jira-sync:2026-07-14T13:10:20.000Z'),
    'job-1-jira-sync-2026-07-14T13-10-20-000Z'
  );
});
