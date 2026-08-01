import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { processAgentJob } from '../src/services/agent.js';
import { createJobRecord, updateJob } from '../src/services/jobStore.js';

test('queued Jira-source implementation, validation, and deployment actions are blocked when Jira is disabled', async () => {
  config.jiraEnabled = false;
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-jira-disabled-'));
  const jobId = `jira-worker-disabled-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005-owner',
    source: 'jira-webhook',
    jiraIssueKey: 'SAPA-126',
    prompt: 'Analyze Jira issue SAPA-126'
  });
  await updateJob(jobId, { status: 'IMPLEMENTING' });

  for (const action of ['implement', 'validate', 'deploy']) {
    await assert.rejects(
      processAgentJob({ jobId, action, actor: '005-owner' }),
      (error) => error.statusCode === 409 && error.code === 'JIRA_DISABLED'
    );
  }
});

test('queued Salesforce-chat conversation action is allowed when Jira is disabled', async () => {
  config.jiraEnabled = false;
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-agent-chat-disabled-'));
  const jobId = `chat-worker-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005-owner',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });

  const result = await processAgentJob({ jobId, action: 'understand', actor: '005-owner' });
  assert.equal(result.status, 'RECEIVED');
});
