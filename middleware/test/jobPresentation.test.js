import test from 'node:test';
import assert from 'node:assert/strict';
import { publicJob } from '../src/services/jobPresentation.js';

test('public job includes business-readable direct-chat status', () => {
  const job = publicJob({
    jobId: 'job-1',
    status: 'AWAITING_IMPLEMENTATION_APPROVAL',
    prompt: 'Create a field',
    workItems: [],
    revisions: [],
    conversation: []
  });

  assert.equal(job.status, 'AWAITING_IMPLEMENTATION_APPROVAL');
  assert.equal(job.statusLabel, 'Plan ready for review');
  assert.equal(job.prompt, undefined);
});

test('public job retains legacy state while projecting Phase 1 wording', () => {
  const job = publicJob({
    jobId: 'legacy-1',
    status: 'ANALYZING_JIRA',
    prompt: 'Historical issue',
    workItems: [],
    revisions: [],
    conversation: []
  });

  assert.equal(job.status, 'ANALYZING_JIRA');
  assert.equal(job.statusLabel, 'Understanding the request');
});
