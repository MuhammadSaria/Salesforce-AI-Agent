import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createJobRecord, getJobRecord, updateJob } from '../src/services/jobStore.js';

test('API rejects missing authentication and accepts configured bearer token', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/orgs`)).status, 401);
  assert.equal((await fetch(`${base}/api/orgs`, { headers: { Authorization: 'Bearer unit-test-token' } })).status, 200);
});

test('API rejects valid Salesforce claim headers without bearer authentication', async (t) => {
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
  assert.equal((await fetch(`${base}/api/orgs`, { headers })).status, 401);
});

test('API rejects invalid bearer token even with valid Salesforce claim headers', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = salesforceHeaders({ authorization: 'Bearer wrong-token' });
  assert.equal((await fetch(`${base}/api/orgs`, { headers })).status, 401);
});

test('direct Salesforce job creation rejects malformed claim headers after bearer authentication', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', orgId: 'not-an-org-id' }),
    body: JSON.stringify({ prompt: 'Create a Flow' })
  });

  assert.equal(response.status, 401);
});

test('valid token plus valid Salesforce claim headers produces a direct actor', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const resolverCalls = [];
  const server = createApp({
    resolveSameOrg: async (input) => {
      resolverCalls.push(input);
      return {
        orgRegistryId: 'providus_orgfarm_dev',
        expectedOrgId: input.authenticatedOrgId,
        environment: 'developer',
        salesforceAlias: 'orgfarm-dev'
      };
    }
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: true }),
    body: JSON.stringify({ prompt: 'Create a Flow', orgId: '00D000000000BAD', canImplement: false })
  });
  const body = await response.json();
  const job = await getJobRecord(body.jobId);

  assert.equal(response.status, 201);
  assert.equal(job.userId, '005g5000009ImIkAAK');
  assert.equal(job.orgId, '00Dg500000E07e9EAB');
  assert.equal(job.orgContext.orgRegistryId, 'providus_orgfarm_dev');
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].authenticatedOrgId, '00Dg500000E07e9EAB');
  assert.equal(resolverCalls[0].requestedOrgId, undefined);
});

test('Salesforce permission claims come from authenticated headers and ignore JSON bodies', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp({
    resolveSameOrg: async (input) => ({
      orgRegistryId: 'providus_orgfarm_dev',
      expectedOrgId: input.authenticatedOrgId,
      environment: 'developer',
      salesforceAlias: 'orgfarm-dev'
    })
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer unit-test-token',
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
  assert.equal((await getJobRecord(createdBody.jobId)).orgId, '00Dg500000E07e9EAB');
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

test('viewer and split permission claims cannot widen approval access', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp({
    resolveSameOrg: async (input) => ({
      orgRegistryId: 'providus_orgfarm_dev',
      expectedOrgId: input.authenticatedOrgId,
      environment: 'developer',
      salesforceAlias: 'orgfarm-dev'
    })
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `authz-${Date.now()}`;
  await createApprovalReadyJob(jobId);

  const viewer = await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token' }),
    body: JSON.stringify({ planVersion: 1 })
  });
  assert.equal(viewer.status, 403);

  const deployOnly = await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canDeploy: true }),
    body: JSON.stringify({ planVersion: 1 })
  });
  assert.equal(deployOnly.status, 403);

  await updateJob(jobId, {
    status: 'AWAITING_DEPLOYMENT_APPROVAL',
    validation: { validationId: 'validation-1', sourceHash: 'source-hash', packageHash: 'package-hash' }
  });
  const implementOnly = await fetch(`${base}/api/jobs/${jobId}/approve-deployment`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: true }),
    body: JSON.stringify({ validationId: 'validation-1' })
  });
  assert.equal(implementOnly.status, 403);
});

async function createApprovalReadyJob(jobId) {
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, {
    status: 'AWAITING_PLAN_APPROVAL',
    plan: { planVersion: 1, planHash: 'plan-hash', materialChangeHash: 'material-hash' },
    metadataScope: { hash: 'scope-hash' },
    orgContext: { orgRegistryId: 'providus_orgfarm_dev', expectedOrgId: '00Dg500000E07e9EAB', environment: 'developer' }
  });
}

function salesforceHeaders({ authorization, orgId = '00Dg500000E07e9EAB', userId = '005g5000009ImIkAAK', canImplement = false, canDeploy = false } = {}) {
  return {
    ...(authorization ? { Authorization: authorization } : {}),
    'Content-Type': 'application/json',
    'X-Agent-Source': 'Salesforce-Apex',
    'X-Agent-Org-Id': orgId,
    'X-Agent-User-Id': userId,
    'X-Agent-Can-Implement': String(canImplement),
    'X-Agent-Can-Deploy': String(canDeploy)
  };
}
