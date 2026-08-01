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

test('bearer token with caller supplied admin role cannot access Salesforce chat jobs without claims', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `role-downgrade-${Date.now()}`;
  await createApprovalReadyJob(jobId);

  const genericAdminHeaders = {
    Authorization: 'Bearer unit-test-token',
    'Content-Type': 'application/json',
    'X-Agent-User-Id': '005g5000009OtherAAK',
    'X-Agent-Role': 'admin'
  };

  assert.equal((await fetch(`${base}/api/jobs/${jobId}`, { headers: genericAdminHeaders })).status, 401);
  assert.equal((await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
    method: 'POST',
    headers: genericAdminHeaders,
    body: JSON.stringify({ planVersion: 1 })
  })).status, 401);
  assert.equal((await fetch(`${base}/api/jobs/${jobId}/implement`, {
    method: 'POST',
    headers: genericAdminHeaders,
    body: JSON.stringify({ role: 'admin', canImplement: true })
  })).status, 401);
});

test('bearer token with caller supplied deployer role cannot approve Salesforce chat deployment without claims', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `role-deployer-${Date.now()}`;
  await createDeploymentReadyJob(jobId);

  const response = await fetch(`${base}/api/jobs/${jobId}/approve-deployment`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer unit-test-token',
      'Content-Type': 'application/json',
      'X-Agent-User-Id': '005g5000009OtherAAK',
      'X-Agent-Role': 'deployer'
    },
    body: JSON.stringify({ validationId: 'validation-1', canDeploy: true, role: 'deployer' })
  });

  assert.equal(response.status, 401);
});

test('incomplete Salesforce claim headers fail closed after bearer authentication', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer unit-test-token',
      'Content-Type': 'application/json',
      'X-Agent-Source': 'Salesforce-Apex',
      'X-Agent-Org-Id': '00Dg500000E07e9EAB',
      'X-Agent-Can-Implement': 'true',
      'X-Agent-Role': 'admin'
    },
    body: JSON.stringify({ prompt: 'Create a Flow' })
  });

  assert.equal(response.status, 401);
});

test('Salesforce claims false stay unprivileged even when X-Agent-Role is admin', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp({ resolveSameOrg: async (input) => trustedTestContext(input.authenticatedOrgId) }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `role-ignored-${Date.now()}`;
  await createApprovalReadyJob(jobId);

  const response = await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
    method: 'POST',
    headers: { ...salesforceHeaders({ authorization: 'Bearer unit-test-token' }), 'X-Agent-Role': 'admin' },
    body: JSON.stringify({ planVersion: 1, role: 'admin', canImplement: true })
  });

  assert.equal(response.status, 403);
});

test('Salesforce implementation and deployment permission claims are independent', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp({ resolveSameOrg: async (input) => trustedTestContext(input.authenticatedOrgId) }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const implementJobId = `implement-only-${Date.now()}`;
  await createApprovalReadyJob(implementJobId);

  const implementation = await fetch(`${base}/api/jobs/${implementJobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: true, canDeploy: false }),
    body: JSON.stringify({ planVersion: 1 })
  });
  assert.equal(implementation.status, 201);

  const deployBlockedJobId = `implement-not-deploy-${Date.now()}`;
  await createDeploymentReadyJob(deployBlockedJobId);
  const deployBlocked = await fetch(`${base}/api/jobs/${deployBlockedJobId}/approve-deployment`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: true, canDeploy: false }),
    body: JSON.stringify({ validationId: 'validation-1' })
  });
  assert.equal(deployBlocked.status, 403);

  const deployJobId = `deploy-only-${Date.now()}`;
  await createDeploymentReadyJob(deployJobId);
  const implementationBlocked = await fetch(`${base}/api/jobs/${deployJobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: false, canDeploy: true }),
    body: JSON.stringify({ planVersion: 1 })
  });
  assert.equal(implementationBlocked.status, 403);

  const deployment = await fetch(`${base}/api/jobs/${deployJobId}/approve-deployment`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', canImplement: false, canDeploy: true }),
    body: JSON.stringify({ validationId: 'validation-1' })
  });
  assert.equal(deployment.status, 201);
});

test('Salesforce owner without implementation or deployment permissions can converse but cannot approve', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp({ resolveSameOrg: async (input) => trustedTestContext(input.authenticatedOrgId) }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobId = `owner-viewer-${Date.now()}`;
  await createApprovalReadyJob(jobId);

  const message = await fetch(`${base}/api/jobs/${jobId}/messages`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token' }),
    body: JSON.stringify({ text: 'Please adjust the labels.', role: 'admin', canImplement: true })
  });
  assert.equal(message.status, 202);

  const approval = await fetch(`${base}/api/jobs/${jobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token' }),
    body: JSON.stringify({ planVersion: 1, role: 'admin', canImplement: true })
  });
  assert.equal(approval.status, 403);
});

test('Salesforce actor cannot list cross-org jobs or widen list with spoofed org fields', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp({ resolveSameOrg: async (input) => trustedTestContext(input.authenticatedOrgId) }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = Date.now();
  const orgAOwnerJobId = `org-a-owner-${suffix}`;
  const orgAAdminJobId = `org-a-admin-${suffix}`;
  const orgBJobId = `org-b-hidden-${suffix}`;
  await createApprovalReadyJob(orgAOwnerJobId, { userId: ORG_A_USER_ID, orgId: ORG_A_ID });
  await createApprovalReadyJob(orgAAdminJobId, { userId: ORG_B_USER_ID, orgId: ORG_A_ID });
  await createApprovalReadyJob(orgBJobId, { userId: ORG_B_USER_ID, orgId: ORG_B_ID });

  const ownerList = await fetch(`${base}/api/jobs?orgId=${ORG_B_ID}&canImplement=true`, {
    headers: salesforceHeaders({
      authorization: 'Bearer unit-test-token',
      orgId: ORG_A_ID,
      userId: ORG_A_USER_ID,
      canImplement: false,
      canDeploy: false
    })
  });
  const ownerBody = await ownerList.json();
  const relevantOwnerJobs = ownerBody.jobs.map((job) => job.jobId).filter((jobId) => [orgAOwnerJobId, orgAAdminJobId, orgBJobId].includes(jobId));
  assert.equal(ownerList.status, 200);
  assert.deepEqual(relevantOwnerJobs.sort(), [orgAOwnerJobId]);

  const adminList = await fetch(`${base}/api/jobs?orgId=${ORG_B_ID}`, {
    headers: {
      ...salesforceHeaders({
        authorization: 'Bearer unit-test-token',
        orgId: ORG_A_ID,
        userId: ORG_A_USER_ID,
        canImplement: true,
        canDeploy: false
      }),
      'X-Agent-Role': 'admin'
    },
    body: undefined
  });
  const adminBody = await adminList.json();
  const relevantAdminJobs = adminBody.jobs.map((job) => job.jobId).filter((jobId) => [orgAOwnerJobId, orgAAdminJobId, orgBJobId].includes(jobId));
  assert.equal(adminList.status, 200);
  assert.deepEqual(relevantAdminJobs.sort(), [orgAAdminJobId, orgAOwnerJobId].sort());

  const deployOnlyList = await fetch(`${base}/api/jobs`, {
    headers: salesforceHeaders({
      authorization: 'Bearer unit-test-token',
      orgId: ORG_A_ID,
      userId: ORG_A_USER_ID,
      canImplement: false,
      canDeploy: true
    })
  });
  const deployOnlyBody = await deployOnlyList.json();
  const relevantDeployOnlyJobs = deployOnlyBody.jobs.map((job) => job.jobId).filter((jobId) => [orgAOwnerJobId, orgAAdminJobId, orgBJobId].includes(jobId));
  assert.equal(deployOnlyList.status, 200);
  assert.deepEqual(relevantDeployOnlyJobs.sort(), [orgAOwnerJobId]);
});

test('Salesforce list endpoint fails closed for missing or incomplete claims', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  await createApprovalReadyJob(`list-claims-${Date.now()}`, { userId: ORG_A_USER_ID, orgId: ORG_A_ID });

  const bearerOnly = await fetch(`${base}/api/jobs`, {
    headers: { Authorization: 'Bearer unit-test-token', 'X-Agent-Role': 'admin' }
  });
  assert.equal(bearerOnly.status, 401);

  const incomplete = await fetch(`${base}/api/jobs`, {
    headers: {
      Authorization: 'Bearer unit-test-token',
      'X-Agent-Source': 'Salesforce-Apex',
      'X-Agent-Org-Id': ORG_A_ID,
      'X-Agent-Can-Implement': 'true',
      'X-Agent-Can-Deploy': 'false'
    }
  });
  assert.equal(incomplete.status, 401);
});

test('cross-org Salesforce actor cannot read, message, cancel, approve, reject, queue, validate, or deploy', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp({ resolveSameOrg: async (input) => trustedTestContext(input.authenticatedOrgId) }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = Date.now();
  const implementationJobId = `org-b-impl-${suffix}`;
  const deploymentJobId = `org-b-deploy-${suffix}`;
  await createApprovalReadyJob(implementationJobId, { userId: ORG_B_USER_ID, orgId: ORG_B_ID });
  await createDeploymentReadyJob(deploymentJobId, { userId: ORG_B_USER_ID, orgId: ORG_B_ID });
  const beforeImplementation = stableJobSnapshot(await getJobRecord(implementationJobId));
  const beforeDeployment = stableJobSnapshot(await getJobRecord(deploymentJobId));
  const orgAImplementAdmin = salesforceHeaders({
    authorization: 'Bearer unit-test-token',
    orgId: ORG_A_ID,
    userId: ORG_A_USER_ID,
    canImplement: true,
    canDeploy: false
  });
  const orgADeployAdmin = salesforceHeaders({
    authorization: 'Bearer unit-test-token',
    orgId: ORG_A_ID,
    userId: ORG_A_USER_ID,
    canImplement: false,
    canDeploy: true
  });

  const attempts = [
    fetch(`${base}/api/jobs/${implementationJobId}`, { headers: orgAImplementAdmin }),
    fetch(`${base}/api/jobs/${implementationJobId}/messages`, { method: 'POST', headers: orgAImplementAdmin, body: JSON.stringify({ text: 'cross-org message' }) }),
    fetch(`${base}/api/jobs/${implementationJobId}/cancel`, { method: 'POST', headers: orgAImplementAdmin, body: JSON.stringify({ reason: 'cross-org cancel' }) }),
    fetch(`${base}/api/jobs/${implementationJobId}/approve-implementation`, { method: 'POST', headers: orgAImplementAdmin, body: JSON.stringify({ planVersion: 1 }) }),
    fetch(`${base}/api/jobs/${implementationJobId}/reject-plan`, { method: 'POST', headers: orgAImplementAdmin, body: JSON.stringify({ comments: 'cross-org reject' }) }),
    fetch(`${base}/api/jobs/${implementationJobId}/implement`, { method: 'POST', headers: orgAImplementAdmin, body: JSON.stringify({}) }),
    fetch(`${base}/api/jobs/${implementationJobId}/validate`, { method: 'POST', headers: orgAImplementAdmin, body: JSON.stringify({}) }),
    fetch(`${base}/api/jobs/${deploymentJobId}/approve-deployment`, { method: 'POST', headers: orgADeployAdmin, body: JSON.stringify({ validationId: 'validation-1' }) }),
    fetch(`${base}/api/jobs/${deploymentJobId}/reject-deployment`, { method: 'POST', headers: orgADeployAdmin, body: JSON.stringify({ validationId: 'validation-1' }) }),
    fetch(`${base}/api/jobs/${deploymentJobId}/deploy`, { method: 'POST', headers: orgADeployAdmin, body: JSON.stringify({}) })
  ];
  const responses = await Promise.all(attempts);
  for (const response of responses) assert.equal(response.status, 404);

  assert.deepEqual(stableJobSnapshot(await getJobRecord(implementationJobId)), beforeImplementation);
  assert.deepEqual(stableJobSnapshot(await getJobRecord(deploymentJobId)), beforeDeployment);
});

test('same-org Salesforce claims retain owner, implementation, and deployment permissions', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const server = createApp({ resolveSameOrg: async (input) => trustedTestContext(input.authenticatedOrgId) }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const suffix = Date.now();

  const ownerJobId = `same-org-owner-${suffix}`;
  await createApprovalReadyJob(ownerJobId, { userId: ORG_A_USER_ID, orgId: ORG_A_ID });
  const ownerMessage = await fetch(`${base}/api/jobs/${ownerJobId}/messages`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', orgId: ORG_A_ID, userId: ORG_A_USER_ID }),
    body: JSON.stringify({ text: 'same org owner message' })
  });
  assert.equal(ownerMessage.status, 202);

  const implementationJobId = `same-org-impl-${suffix}`;
  await createApprovalReadyJob(implementationJobId, { userId: ORG_B_USER_ID, orgId: ORG_A_ID });
  const implementationApproval = await fetch(`${base}/api/jobs/${implementationJobId}/approve-implementation`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', orgId: ORG_A_ID, userId: ORG_A_USER_ID, canImplement: true }),
    body: JSON.stringify({ planVersion: 1 })
  });
  assert.equal(implementationApproval.status, 201);

  const deploymentJobId = `same-org-deploy-${suffix}`;
  await createDeploymentReadyJob(deploymentJobId, { userId: ORG_B_USER_ID, orgId: ORG_A_ID });
  const deploymentApproval = await fetch(`${base}/api/jobs/${deploymentJobId}/approve-deployment`, {
    method: 'POST',
    headers: salesforceHeaders({ authorization: 'Bearer unit-test-token', orgId: ORG_A_ID, userId: ORG_A_USER_ID, canDeploy: true }),
    body: JSON.stringify({ validationId: 'validation-1' })
  });
  assert.equal(deploymentApproval.status, 201);
});

async function createApprovalReadyJob(jobId, { userId = ORG_A_USER_ID, orgId = ORG_A_ID } = {}) {
  await createJobRecord({
    jobId,
    userId,
    orgId,
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, {
    status: 'AWAITING_IMPLEMENTATION_APPROVAL',
    plan: { planVersion: 1, planHash: 'plan-hash', materialChangeHash: 'material-hash' },
    metadataScope: { hash: 'scope-hash' },
    orgContext: { orgRegistryId: 'providus_orgfarm_dev', expectedOrgId: orgId, environment: 'developer' }
  });
}

async function createDeploymentReadyJob(jobId, options = {}) {
  await createApprovalReadyJob(jobId, options);
  await updateJob(jobId, {
    status: 'AWAITING_DEPLOYMENT_APPROVAL',
    validation: { validationId: 'validation-1', targetOrgId: options.orgId || ORG_A_ID, sourceHash: 'source-hash', packageHash: 'package-hash' }
  });
}

function trustedTestContext(expectedOrgId) {
  return {
    orgRegistryId: 'providus_orgfarm_dev',
    expectedOrgId,
    environment: 'developer',
    salesforceAlias: 'orgfarm-dev'
  };
}

function stableJobSnapshot(job) {
  return {
    status: job.status,
    messages: job.messages,
    approvals: job.approvals,
    audit: job.audit,
    stateHistory: job.stateHistory,
    logs: job.logs,
    commands: job.commands,
    workItems: job.workItems
  };
}

const ORG_A_ID = '00Dg500000E07e9EAB';
const ORG_B_ID = '00Dg500000E07fAEAR';
const ORG_A_USER_ID = '005g5000009ImIkAAK';
const ORG_B_USER_ID = '005g5000009OrgBAAS';

function salesforceHeaders({ authorization, orgId = ORG_A_ID, userId = ORG_A_USER_ID, canImplement = false, canDeploy = false } = {}) {
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
