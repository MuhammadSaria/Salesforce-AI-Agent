import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { getJobRecord, updateJob } from '../src/services/jobStore.js';

test('API rejects missing authentication and accepts configured bearer token', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/orgs`)).status, 401);
  assert.equal((await fetch(`${base}/api/orgs`, { headers: { Authorization: 'Bearer unit-test-token' } })).status, 200);
});

test('API accepts trusted Salesforce Apex context when the Named Credential is anonymous', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    'X-Agent-Source': 'Salesforce-Apex',
    'X-Agent-Org-Id': '00Dg500000E07e9EAB',
    'X-Agent-User-Id': '005g5000009ImIkAAK',
    'X-Agent-Can-Implement': 'false',
    'X-Agent-Can-Deploy': 'false',
    'X-Agent-Role': 'admin'
  };
  assert.equal((await fetch(`${base}/api/orgs`, { headers })).status, 200);
});

test('Salesforce permission claims come from authenticated headers and ignore JSON bodies', async (t) => {
  config.apiAuthToken = '';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Agent-Source': 'Salesforce-Apex',
    'X-Agent-Org-Id': '00Dg500000E07e9EAB',
    'X-Agent-User-Id': '005g5000009ImIkAAK',
    'X-Agent-Can-Implement': 'false',
    'X-Agent-Can-Deploy': 'false'
  };

  const created = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: 'Create a Flow',
      orgId: '00D-OTHER',
      role: 'admin',
      canImplement: true,
      canDeploy: true
    })
  });
  const createdBody = await created.json();

  assert.equal(created.status, 201);
  assert.equal((await getJobRecord(createdBody.jobId)).orgId, '00DG500000E07E9');
  await updateJob(createdBody.jobId, {
    status: 'AWAITING_PLAN_APPROVAL',
    plan: { planVersion: 1, planHash: 'plan-hash', materialChangeHash: 'material-hash' },
    metadataScope: { hash: 'scope-hash' },
    orgContext: { orgRegistryId: 'providus_orgfarm_dev', expectedOrgId: '00Dg500000E07e9EAB', environment: 'developer' }
  });
  const approval = await fetch(`${base}/api/jobs/${createdBody.jobId}/approve-implementation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ planVersion: 1, canImplement: true, role: 'admin' })
  });

  assert.equal(approval.status, 403);
});
