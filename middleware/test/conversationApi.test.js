import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';

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
  assert.equal(analyzed.status, 409);

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

async function testServer() {
  config.apiAuthToken = '';
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
