import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createJobRecord, getJobRecord, updateJob } from '../src/services/jobStore.js';

const promptRequired = {
  error: {
    code: 'PROMPT_REQUIRED',
    message: 'Enter a Salesforce development request.'
  }
};

test('any authenticated Salesforce user can start and continue their own job', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);

  const created = await postJson(`${base}/api/jobs`, {
    prompt: 'Create a recurring donation installment Flow',
    jiraIssueKey: 'SAPA-123'
  }, viewerHeaders('005-owner'));

  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'RECEIVED');

  const job = await getJson(`${base}/api/jobs/${created.body.jobId}`, viewerHeaders('005-owner'));
  assert.equal(job.status, 200);
  assert.equal(job.body.source, 'salesforce-chat');
  assert.equal(job.body.jiraIssueKey, '');

  const replied = await postJson(`${base}/api/jobs/${created.body.jobId}/messages`, {
    text: 'Only completed donations count.'
  }, viewerHeaders('005-owner'));

  assert.equal(replied.status, 202);
  assert.equal(replied.body.status, 'RECEIVED');

  const updated = await getJson(`${base}/api/jobs/${created.body.jobId}`, viewerHeaders('005-owner'));
  assert.equal(updated.body.conversation.length, 2);
  assert.equal(updated.body.stateHistory.some((event) => String(event.newState).includes('JIRA')), false);
});

test('conversation routes preserve owner and admin job isolation', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);

  const created = await postJson(`${base}/api/jobs`, {
    prompt: 'Create a Flow'
  }, viewerHeaders('005-owner'));

  assert.equal(created.status, 201);

  const blocked = await postJson(`${base}/api/jobs/${created.body.jobId}/messages`, {
    text: 'Change someone else job'
  }, viewerHeaders('005-other'));
  assert.equal(blocked.status, 404);

  const admin = await postJson(`${base}/api/jobs/${created.body.jobId}/messages`, {
    text: 'Admin follow-up'
  }, viewerHeaders('005-admin', 'admin'));
  assert.equal(admin.status, 202);
});

test('starting a Salesforce chat job requires a prompt before sanitization', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);

  for (const body of [{}, { prompt: '' }, { prompt: '   \n\t  ' }]) {
    const response = await postJson(`${base}/api/jobs`, body, viewerHeaders('005-owner'));

    assert.equal(response.status, 422);
    assert.deepEqual(response.body, promptRequired);
    assert.equal(JSON.stringify(response.body).includes('sanitizePrompt'), false);
    assert.equal(JSON.stringify(response.body).includes('stack'), false);
  }
});

test('job owner can cancel their own job but approval routes remain role gated', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);

  const created = await postJson(`${base}/api/jobs`, {
    prompt: 'Create a Flow'
  }, viewerHeaders('005-owner'));

  assert.equal(created.status, 201);

  const approval = await postJson(`${base}/api/jobs/${created.body.jobId}/approve-implementation`, {
    planVersion: 1
  }, viewerHeaders('005-owner'));
  assert.equal(approval.status, 403);

  const cancelled = await postJson(`${base}/api/jobs/${created.body.jobId}/cancel`, {
    reason: 'No longer needed'
  }, viewerHeaders('005-owner'));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'CANCELLED');
});

test('new Salesforce chat jobs cannot enter the legacy Jira analysis route', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);

  const created = await postJson(`${base}/api/jobs`, {
    prompt: 'Create a Flow'
  }, viewerHeaders('005-owner', 'developer'));

  assert.equal(created.status, 201);

  const analyzed = await postJson(`${base}/api/jobs/${created.body.jobId}/analyze`, {}, viewerHeaders('005-owner', 'developer'));
  assert.equal(analyzed.status, 404);

  const job = await getJson(`${base}/api/jobs/${created.body.jobId}`, viewerHeaders('005-owner', 'developer'));
  assert.equal(job.body.stateHistory.some((event) => String(event.newState).includes('JIRA')), false);
});

test('Jira webhook is not registered when Jira is disabled by default', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);

  assert.equal(config.jiraEnabled, false);
  const response = await postJson(`${base}/api/webhooks/jira`, {
    webhookEvent: 'jira:issue_created'
  }, {});

  assert.equal(response.status, 404);
});

test('Jira-specific routes are unavailable and historical Jira jobs remain readable when disabled', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);
  const jobId = `jira-disabled-read-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005-owner',
    source: 'jira-webhook',
    jiraIssueKey: 'SAPA-123',
    prompt: 'Analyze Jira issue SAPA-123'
  });

  const read = await getJson(`${base}/api/jobs/${jobId}`, viewerHeaders('005-owner', 'developer'));
  assert.equal(read.status, 200);
  assert.equal(read.body.source, 'jira-webhook');
  assert.equal(read.body.jiraIssueKey, 'SAPA-123');

  assert.equal((await postJson(`${base}/api/jobs/${jobId}/analyze`, {}, viewerHeaders('005-owner', 'developer'))).status, 404);
  assert.equal((await postJson(`${base}/api/jobs/${jobId}/instructions`, { instruction: 'Revise it' }, viewerHeaders('005-owner', 'developer'))).status, 404);
});

test('generic action routes reject Jira-source jobs when Jira is disabled', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);
  const jobId = `jira-disabled-mutate-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005-owner',
    source: 'jira-webhook',
    jiraIssueKey: 'SAPA-124',
    prompt: 'Analyze Jira issue SAPA-124'
  });
  await updateJob(jobId, {
    status: 'IMPLEMENTING',
    plan: { planVersion: 1, planHash: 'plan-hash', materialChangeHash: 'material-hash' },
    metadataScope: { hash: 'scope-hash' },
    orgContext: { expectedOrgId: '00DTEST' }
  });

  for (const route of ['implement', 'validate']) {
    const response = await postJson(`${base}/api/jobs/${jobId}/${route}`, {}, viewerHeaders('005-owner', 'developer'));
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'JIRA_DISABLED');
  }

  await updateJob(jobId, {
    status: 'AWAITING_DEPLOYMENT_APPROVAL',
    validation: { validationId: 'validation-1', sourceHash: 'source-hash', packageHash: 'package-hash' }
  });
  const deployment = await postJson(`${base}/api/jobs/${jobId}/approve-deployment`, {
    validationId: 'validation-1'
  }, viewerHeaders('005-owner', 'deployer'));
  assert.equal(deployment.status, 409);
  assert.equal(deployment.body.error.code, 'JIRA_DISABLED');
});

test('Jira-source messages are immutable when Jira is disabled', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);
  const jobId = `jira-disabled-message-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005-owner',
    source: 'jira-webhook',
    jiraIssueKey: 'SAPA-126',
    prompt: 'Analyze Jira issue SAPA-126'
  });
  const before = await getJobRecord(jobId);

  const response = await postJson(`${base}/api/jobs/${jobId}/messages`, {
    text: 'Please add more context.'
  }, viewerHeaders('005-owner'));
  await waitForQueueTick();
  const after = await getJobRecord(jobId);

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'JIRA_DISABLED');
  assert.deepEqual(after.conversation, before.conversation);
  assert.deepEqual(after.audit, before.audit);
  assert.deepEqual(after.stateHistory, before.stateHistory);
  assert.deepEqual(after.logs, before.logs);
  assert.equal(after.status, before.status);
});

test('Salesforce chat messages still append when Jira is disabled', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);

  const created = await postJson(`${base}/api/jobs`, {
    prompt: 'Create a validation rule'
  }, viewerHeaders('005-owner'));
  assert.equal(created.status, 201);
  const before = await getJobRecord(created.body.jobId);

  const response = await postJson(`${base}/api/jobs/${created.body.jobId}/messages`, {
    text: 'It should apply only to active accounts.'
  }, viewerHeaders('005-owner'));
  const after = await getJobRecord(created.body.jobId);

  assert.equal(response.status, 202);
  assert.equal(after.conversation.length, before.conversation.length + 1);
  assert.equal(after.audit.length, before.audit.length + 1);
  assert.equal(after.status, before.status);
});

test('Jira-source messages still append when Jira is enabled', async (t) => {
  config.jiraEnabled = true;
  const { base, close } = await testServer(t);
  t.after(() => {
    config.jiraEnabled = false;
    close();
  });
  const jobId = `jira-enabled-message-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005-owner',
    source: 'jira-webhook',
    jiraIssueKey: 'SAPA-127',
    prompt: 'Analyze Jira issue SAPA-127'
  });
  const before = await getJobRecord(jobId);

  const response = await postJson(`${base}/api/jobs/${jobId}/messages`, {
    text: 'Preserve historical Jira conversation behavior.'
  }, viewerHeaders('005-owner'));
  const after = await getJobRecord(jobId);

  assert.equal(response.status, 202);
  assert.equal(after.conversation.length, before.conversation.length + 1);
  assert.equal(after.audit.length, before.audit.length + 1);
  assert.equal(after.status, before.status);
});

test('Salesforce chat jobs continue through generic action routes when Jira is disabled', async (t) => {
  const { base, close } = await testServer(t);
  t.after(close);
  const jobId = `chat-action-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005-owner',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, { status: 'RECEIVED' });

  const response = await postJson(`${base}/api/jobs/${jobId}/implement`, {}, viewerHeaders('005-owner', 'developer'));
  assert.equal(response.status, 409);
  assert.notEqual(response.body.error.code, 'JIRA_DISABLED');
});

test('Jira-specific routes remain available when Jira is enabled', async (t) => {
  config.jiraEnabled = true;
  const { base, close } = await testServer(t);
  t.after(() => {
    config.jiraEnabled = false;
    close();
  });
  const jobId = `jira-enabled-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005-owner',
    source: 'jira-webhook',
    jiraIssueKey: 'SAPA-125',
    prompt: 'Analyze Jira issue SAPA-125'
  });
  await updateJob(jobId, { status: 'IMPLEMENTING' });

  const response = await postJson(`${base}/api/jobs/${jobId}/analyze`, {}, viewerHeaders('005-owner', 'developer'));
  assert.equal(response.status, 409);
  assert.notEqual(response.body.error.code, 'JIRA_DISABLED');
});

async function testServer() {
  config.apiAuthToken = '';
  config.jiraEnabled = config.jiraEnabled === true;
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-conversation-api-'));
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close()
  };
}

function viewerHeaders(userId, role = 'viewer') {
  return {
    'X-Agent-User-Id': userId,
    'X-Agent-Role': role,
    'Content-Type': 'application/json'
  };
}

async function postJson(url, body, headers) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function getJson(url, headers) {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function waitForQueueTick() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
