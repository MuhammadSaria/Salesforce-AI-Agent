import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { ARCHITECTURE_PLAN_SCHEMA } from '../src/domain/architecturePlan.js';
import { canonicalInspectionHash } from '../src/domain/inspection.js';
import { processAgentJob, setDirectAnalysisDependenciesForTest, setSameOrgResolverForTest } from '../src/services/agent.js';
import { trustOrgContext } from '../src/services/orgContextTrust.js';
import { createJobRecord, getJobRecord, updateJob } from '../src/services/jobStore.js';
import { inspectFlowRequirement } from '../src/services/orgInspectionService.js';
import { createTestPostgresPool } from './helpers/postgres.js';
import { migrate } from '../src/persistence/migrate.js';

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

  const roleOnlyAdmin = await postJson(`${base}/api/jobs/${created.body.jobId}/messages`, {
    text: 'Role-only admin follow-up'
  }, viewerHeaders('005-admin', 'admin'));
  assert.equal(roleOnlyAdmin.status, 404);
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
    const response = await postJson(`${base}/api/jobs/${jobId}/${route}`, {}, viewerHeaders('005-owner', 'admin'));
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

test('Salesforce chat clarification is bound by HTTP endpoint and replans with only that response', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const queued = [];
  const plannerCalls = [];
  setDirectAnalysisDependenciesForTest({
    inspectFlowRequirement: (input) => inspectFlowRequirement(input, { sf: clarificationSf(), clock: fixedClock, maxComponents: 8, maxObjects: 2 }),
    architecturePlannerDependencies: {
      clock: fixedClock,
      modelRunner: async (input) => {
        plannerCalls.push(input);
        return sourceFreePlan();
      }
    }
  });
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId));
  const { base, close } = await testServer(t, {
    apiAuthToken: 'unit-test-token',
    resolveSameOrg: async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId),
    enqueue: async (message, options) => queued.push({ message, options })
  });
  t.after(() => {
    setDirectAnalysisDependenciesForTest();
    setSameOrgResolverForTest();
    close();
  });

  const created = await postJson(`${base}/api/jobs`, {
    prompt: 'When a Donation becomes Paid or Completed, number it.'
  }, salesforceChatHeaders('005g5000009ImIkAAK'));
  assert.equal(created.status, 201);

  await processAgentJob(queued.shift().message);
  let job = await getJobRecord(created.body.jobId);
  assert.equal(job.status, 'AWAITING_CLARIFICATION');
  assert.equal(job.clarifications.length, 1);
  assert.equal(job.conversation.filter((entry) => entry.kind === 'clarification-response').length, 0);

  const response = await postJson(`${base}/api/jobs/${created.body.jobId}/messages`, {
    text: 'Paid',
    ambiguityId: 'attacker-controlled',
    responseToInspectionHash: 'attacker-controlled',
    responseToPlanVersion: 999,
    orgId: '00Dg500000E07fAEAR'
  }, salesforceChatHeaders('005g5000009ImIkAAK'));

  assert.equal(response.status, 202);
  job = await getJobRecord(created.body.jobId);
  const clarification = job.conversation.at(-1);
  assert.equal(clarification.kind, 'clarification-response');
  assert.equal(clarification.text, 'Paid');
  assert.equal(clarification.ambiguityId, job.clarifications[0].ambiguityId);
  assert.equal(clarification.responseToInspectionHash, job.inspection.hash);
  assert.equal(clarification.responseToInspectionHash, canonicalInspectionHash(job.inspection));
  assert.equal(clarification.responseToPlanVersion, job.iteration);
  assert.equal(clarification.actor, '005g5000009ImIkAAK');
  assert.equal(queued.length, 1);

  await processAgentJob(queued.shift().message);
  job = await getJobRecord(created.body.jobId);
  assert.equal(job.status, 'AWAITING_IMPLEMENTATION_APPROVAL');
  assert.deepEqual(plannerCalls.at(-1).answers, [{
    ambiguityId: 'material:status-values',
    text: 'Paid',
    inspectionHash: job.inspection.hash,
    planVersion: job.iteration
  }]);
  assert.equal(job.requirement.businessRequirement.includes('Paid\nPaid'), false);
  assert.equal(job.requirement.acceptanceCriteria.includes('Paid'), false);
});

test('Salesforce chat specialist clarification response uses trusted server binding', async (t) => {
  config.apiAuthToken = 'unit-test-token';
  const queued = [];
  const currentInspection = specialistInspection();
  const { base, close } = await testServer(t, {
    apiAuthToken: 'unit-test-token',
    resolveSameOrg: async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId),
    enqueue: async (message, options) => queued.push({ message, options })
  });
  t.after(close);

  const jobId = `specialist-api-clarification-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a recurring donation installment Flow.'
  });
  await updateJob(jobId, {
    status: 'AWAITING_CLARIFICATION',
    iteration: 1,
    inspection: currentInspection,
    clarifications: [{
      ambiguityId: 'specialist:FLOW:blocked:v1',
      question: 'Strict uniqueness requires locking-capable Apex. Expand scope?',
      inspectionHash: currentInspection.hash,
      sourceOrgId: '00Dg500000E07e9EAB',
      planVersion: 1,
      planHash: 'plan-hash',
      scopeHash: 'scope-hash',
      specialistId: 'FLOW',
      status: 'OPEN'
    }]
  });

  const response = await postJson(`${base}/api/jobs/${jobId}/messages`, {
    text: 'Expand scope for locking-capable Apex.',
    ambiguityId: 'attacker-controlled',
    responseToInspectionHash: 'attacker-controlled',
    responseToPlanVersion: 999,
    specialistId: 'OBJECT_FIELD'
  }, salesforceChatHeaders('005g5000009ImIkAAK'));

  assert.equal(response.status, 202);
  const job = await getJobRecord(jobId);
  const clarification = job.conversation.at(-1);
  assert.equal(clarification.kind, 'clarification-response');
  assert.equal(clarification.ambiguityId, 'specialist:FLOW:blocked:v1');
  assert.equal(clarification.responseToInspectionHash, currentInspection.hash);
  assert.equal(clarification.responseToPlanVersion, 1);
  assert.equal(clarification.actor, '005g5000009ImIkAAK');
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].message, { jobId, action: 'understand', actor: '005g5000009ImIkAAK' });
});

test('production PostgreSQL repository wiring persists API jobs outside legacy memory store', async (t) => {
  const pool = createTestPostgresPool();
  await migrate(pool);
  t.after(() => pool.end());

  const { base, close } = await testServer(t, {
    pool,
    enqueue: async () => {}
  });
  t.after(close);

  const created = await postJson(`${base}/api/jobs`, {
    prompt: 'Create a validation rule'
  }, viewerHeaders('005-postgres-owner'));
  assert.equal(created.status, 201);

  const durable = await pool.query('SELECT job_id, record FROM development_jobs WHERE job_id = $1', [created.body.jobId]);
  assert.equal(durable.rowCount, 1);
  assert.equal(durable.rows[0].record.prompt, 'Create a validation rule');

  const read = await getJson(`${base}/api/jobs/${created.body.jobId}`, viewerHeaders('005-postgres-owner'));
  assert.equal(read.status, 200);
  assert.equal(read.body.jobId, created.body.jobId);
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

test('Salesforce chat generic action routes fail closed instead of using Jira-disabled handling', async (t) => {
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

  const response = await postJson(`${base}/api/jobs/${jobId}/implement`, {}, viewerHeaders('005-owner', 'admin'));
  assert.equal(response.status, 403);
  assert.notEqual(response.body.error.code, 'JIRA_DISABLED');
});

test('deployment endpoint with missing approval org ID does not transition or queue', async (t) => {
  const queueCalls = [];
  const { base, close } = await testServer(t, { resolveSameOrg: async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId), enqueue: async (job, options) => queueCalls.push({ job, options }) });
  t.after(close);
  const jobId = `deploy-missing-org-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005-owner',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, deploymentReadyPatch({ approvals: [deploymentApproval({ salesforceOrganizationId: '' })] }));
  const before = sideEffectSnapshot(await getJobRecord(jobId), queueCalls);

  const response = await postJson(`${base}/api/jobs/${jobId}/deploy`, {}, deployerHeaders('005g5000009ImIlAAK'));
  await waitForQueueTick();

  assert.equal(response.status, 409);
  assert.equal(JSON.stringify(response.body).includes('00Dg500000E07e9EAB'), false);
  assert.deepEqual(sideEffectSnapshot(await getJobRecord(jobId), queueCalls), before);
});

test('deployment endpoint with mismatched approval org ID does not transition or queue', async (t) => {
  const queueCalls = [];
  const { base, close } = await testServer(t, { resolveSameOrg: async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId), enqueue: async (job, options) => queueCalls.push({ job, options }) });
  t.after(close);
  const jobId = `deploy-mismatch-org-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, deploymentReadyPatch({ approvals: [deploymentApproval({ salesforceOrganizationId: '00Dg500000E07fAEAR' })] }));
  const before = sideEffectSnapshot(await getJobRecord(jobId), queueCalls);

  const response = await postJson(`${base}/api/jobs/${jobId}/deploy`, {}, deployerHeaders('005g5000009ImIlAAK'));
  await waitForQueueTick();

  assert.equal(response.status, 409);
  assert.equal(JSON.stringify(response.body).includes('00Dg500000E07fAEAR'), false);
  assert.deepEqual(sideEffectSnapshot(await getJobRecord(jobId), queueCalls), before);
});

test('deployment endpoint queues correctly org-bound same-org approval', async (t) => {
  const queueCalls = [];
  const { base, close } = await testServer(t, { resolveSameOrg: async ({ authenticatedOrgId }) => trustedContext(authenticatedOrgId), enqueue: async (job, options) => queueCalls.push({ job, options }) });
  t.after(close);
  const jobId = `deploy-valid-org-${Date.now()}`;
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a Flow'
  });
  await updateJob(jobId, deploymentReadyPatch());

  const response = await postJson(`${base}/api/jobs/${jobId}/deploy`, {}, deployerHeaders('005g5000009ImIlAAK'));

  assert.equal(response.status, 202);
  assert.equal((await getJobRecord(jobId)).status, 'DEPLOYING');
  assert.equal(queueCalls.length, 1);
  assert.deepEqual(queueCalls[0].job, { jobId, action: 'deploy', actor: '005g5000009ImIlAAK' });
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

async function testServer(t, options = {}) {
  const previousApiAuthToken = config.apiAuthToken;
  config.apiAuthToken = options.apiAuthToken || '';
  config.jiraEnabled = config.jiraEnabled === true;
  config.workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-conversation-api-'));
  const server = createApp(options).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      config.apiAuthToken = previousApiAuthToken;
      server.close();
    }
  };
}

function viewerHeaders(userId, role = 'viewer') {
  return {
    'X-Agent-User-Id': userId,
    'X-Agent-Role': role,
    'Content-Type': 'application/json'
  };
}

function deployerHeaders(userId) {
  return {
    'X-Agent-User-Id': userId,
    'X-Agent-Source': 'Salesforce-Apex',
    'X-Agent-Role': 'deployer',
    'X-Agent-Org-Id': '00Dg500000E07e9EAB',
    'X-Agent-Can-Deploy': 'true',
    'X-Agent-Can-Implement': 'false',
    'Content-Type': 'application/json'
  };
}

function salesforceChatHeaders(userId) {
  return {
    Authorization: 'Bearer unit-test-token',
    'X-Agent-User-Id': userId,
    'X-Agent-Source': 'Salesforce-Apex',
    'X-Agent-Org-Id': '00Dg500000E07e9EAB',
    'X-Agent-Can-Implement': 'false',
    'X-Agent-Can-Deploy': 'false',
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

function deploymentReadyPatch(overrides = {}) {
  return {
    status: 'AWAITING_DEPLOYMENT_APPROVAL',
    plan: { planVersion: 1, planHash: 'plan-hash', materialChangeHash: 'material-hash', fileOperations: [{ path: 'force-app/main/default/flows/Test.flow-meta.xml', operation: 'modify' }], dataOperations: [] },
    metadataScope: { hash: 'scope-hash' },
    orgContext: {
      orgRegistryId: 'providus_orgfarm_dev',
      expectedOrgId: '00Dg500000E07e9EAB',
      environment: 'developer',
      deploymentPermission: 'allowed',
      allowedOperations: ['read', 'retrieve', 'validate', 'deploy']
    },
    implementation: { approvalId: 'approval-1', sourceHash: 'source-hash', commitHash: 'commit-hash', changedFiles: ['force-app/main/default/flows/Test.flow-meta.xml'], workspacePath: 'implementation/project' },
    validation: {
      validationId: 'validation-1',
      targetOrgId: '00Dg500000E07e9EAB',
      status: 'PASSED',
      sourceHash: 'source-hash',
      commitHash: 'commit-hash',
      planHash: 'plan-hash',
      metadataScopeHash: 'scope-hash',
      packageHash: 'package-hash',
      expiryTimestamp: new Date(Date.now() + 60000).toISOString()
    },
    approvals: [deploymentApproval()],
    ...overrides
  };
}

function deploymentApproval(overrides = {}) {
  return {
    approvalId: 'approval-deploy-1',
    approvalType: 'DEPLOYMENT',
    decision: 'APPROVED',
    planHash: 'plan-hash',
    metadataScopeHash: 'scope-hash',
    validationId: 'validation-1',
    validatedSourceHash: 'source-hash',
    deploymentPackageHash: 'package-hash',
    salesforceOrganizationId: '00Dg500000E07e9EAB',
    ...overrides
  };
}

function sideEffectSnapshot(job, queueCalls) {
  return {
    status: job.status,
    orgContext: job.orgContext,
    stateHistory: job.stateHistory,
    messages: job.specialistMessages,
    approvals: job.approvals,
    auditEvents: job.audit,
    logs: job.logs,
    workItems: job.workItems,
    commands: job.commands,
    queueCalls: [...queueCalls]
  };
}

function trustedContext(expectedOrgId) {
  return trustOrgContext({
    orgRegistryId: 'providus_orgfarm_dev',
    salesforceAlias: 'orgfarm-dev',
    expectedOrgId,
    environment: 'developer',
    deploymentPermission: 'allowed',
    allowedOperations: ['read', 'retrieve', 'validate', 'deploy'],
    verified: { organizationId: expectedOrgId, verifiedAt: fixedClock().toISOString() }
  });
}

function clarificationSf() {
  return {
    async query(request) {
      if (request.operationId === 'object-candidates') {
        return jsonResult([
          { DurableId: 'GiftCommitment', QualifiedApiName: 'GiftCommitment', Label: 'Gift Commitment' },
          { DurableId: 'GiftTransaction', QualifiedApiName: 'GiftTransaction', Label: 'Gift Transaction' }
        ].slice(0, request.limit));
      }
      if (request.operationId === 'field-definition-exact:GiftTransaction.GiftCommitmentId') {
        return jsonResult([{ EntityDefinition: { QualifiedApiName: 'GiftTransaction' }, QualifiedApiName: 'GiftCommitmentId', Label: 'Gift Commitment', DataType: 'Lookup', ReferenceTo: 'GiftCommitment' }]);
      }
      if (request.operationId === 'field-definition-exact:GiftTransaction.Status') {
        return jsonResult([{ EntityDefinition: { QualifiedApiName: 'GiftTransaction' }, QualifiedApiName: 'Status', Label: 'Status', DataType: 'Picklist' }]);
      }
      if (request.operationId === 'picklist-values:GiftTransaction.Status') {
        return jsonResult([
          { EntityParticle: { EntityDefinition: { QualifiedApiName: 'GiftTransaction' }, QualifiedApiName: 'Status' }, Value: 'Paid', Label: 'Paid', IsActive: true },
          { EntityParticle: { EntityDefinition: { QualifiedApiName: 'GiftTransaction' }, QualifiedApiName: 'Status' }, Value: 'Completed', Label: 'Completed', IsActive: true }
        ]);
      }
      return jsonResult([]);
    },
    async verifyOrg() {
      return { organizationId: '00Dg500000E07e9EAB' };
    },
    async retrieveMetadata({ components }) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: 0,
          result: {
            done: true,
            status: 'Succeeded',
            files: components.map((component) => ({ type: component.type, fullName: component.apiName, state: 'Changed' }))
          }
        }),
        stderr: ''
      };
    }
  };
}

function jsonResult(records) {
  return { exitCode: 0, stdout: JSON.stringify({ status: 0, result: { records } }), stderr: '' };
}

function fixedClock() {
  return new Date('2026-08-12T00:00:00.000Z');
}

function sourceFreePlan() {
  const core = {
    requirement: 'When a Donation becomes Paid, number it.',
    acceptanceCriteria: ['Assign a sequential installment number only after a donation is paid.'],
    assumptions: [],
    evidenceIds: ['relationship:GiftTransaction.GiftCommitmentId', 'statusValue:GiftTransaction.Status.Paid'],
    components: [{ operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Implement verified paid numbering behavior.' }],
    expectedBehavior: ['Paid donations are numbered.'],
    testingStrategy: ['Validate in the verified sandbox.'],
    risks: [],
    rollbackStrategy: 'Disable generated metadata before deployment.'
  };
  ARCHITECTURE_PLAN_SCHEMA.parse(core);
  return core;
}

function specialistInspection() {
  const body = {
    sourceOrgId: '00Dg500000E07e9EAB',
    evidence: [{
      evidenceId: 'relationship:GiftTransaction.GiftCommitmentId',
      kind: 'RELATIONSHIP',
      objectApiName: 'GiftTransaction',
      fieldApiName: 'GiftCommitmentId',
      targetObjectApiName: 'GiftCommitment',
      sourceOrgId: '00Dg500000E07e9EAB',
      active: true,
      observedAt: fixedClock().toISOString()
    }]
  };
  return { ...body, hash: canonicalInspectionHash(body) };
}
