import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalInspectionHash } from '../src/domain/inspection.js';
import { processAgentJob, setDirectAnalysisDependenciesForTest, setSameOrgResolverForTest } from '../src/services/agent.js';
import { appendConversation, createJobRecord, getJobRecord, updateJob } from '../src/services/jobStore.js';

test.beforeEach(() => {
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => orgContext(authenticatedOrgId));
});

test.afterEach(() => {
  setSameOrgResolverForTest();
});

test('direct jobs use createArchitecturePlan and persist no source-generation fields', async (t) => {
  const jobId = `direct-planner-${Date.now()}`;
  const calls = [];
  setDirectAnalysisDependenciesForTest({
    inspectFlowRequirement: async () => inspection(),
    createArchitecturePlan: async (input) => {
      calls.push(input);
      return plan();
    }
  });
  t.after(() => setDirectAnalysisDependenciesForTest());

  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a recurring donation installment Flow.'
  });
  await updateJob(jobId, { orgContext: orgContext() });

  await processAgentJob({ jobId, action: 'understand', actor: '005g5000009ImIkAAK' });

  const updated = await getJobRecord(jobId);
  assert.equal(calls.length, 1);
  assert.equal(updated.status, 'AWAITING_IMPLEMENTATION_APPROVAL');
  assert.equal(updated.plan.components.at(-1).metadataType, 'Flow');
  assert.equal('fileOperations' in updated.plan, false);
  assert.equal(JSON.stringify(updated.plan).includes('<Flow'), false);
});

test('direct planning records material clarification without source generation', async (t) => {
  const jobId = `direct-clarification-${Date.now()}`;
  let plannerCalled = false;
  setDirectAnalysisDependenciesForTest({
    inspectFlowRequirement: async () => ({
      ...inspection(),
      ambiguities: [{ ambiguityId: 'material:status-values', material: true, question: 'Confirm paid status.' }]
    }),
    createArchitecturePlan: async () => {
      plannerCalled = true;
      throw Object.assign(new Error('Confirm paid status.'), { code: 'MATERIAL_CLARIFICATION_REQUIRED' });
    }
  });
  t.after(() => setDirectAnalysisDependenciesForTest());

  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Number paid recurring donations.'
  });
  await updateJob(jobId, { orgContext: orgContext() });

  await processAgentJob({ jobId, action: 'understand', actor: '005g5000009ImIkAAK' });

  const updated = await getJobRecord(jobId);
  assert.equal(plannerCalled, true);
  assert.equal(updated.status, 'AWAITING_CLARIFICATION');
  assert.equal(updated.plan, null);
  assert.equal(updated.workItems.length, 0);
});

test('direct clarification response resolves paid ambiguity without reusing original prompt as answer', async (t) => {
  const jobId = `direct-clarification-e2e-${Date.now()}`;
  const plannerCalls = [];
  setDirectAnalysisDependenciesForTest({
    inspectFlowRequirement: async () => ({
      ...inspection(),
      evidence: [
        ...inspection().evidence,
        { evidenceId: 'evidence:status-paid', kind: 'STATUS_VALUE', objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Paid', sourceOrgId: '00Dg500000E07e9EAB', active: true, observedAt: '2026-08-12T00:00:00.000Z' }
      ],
      statusCandidates: [{ objectApiName: 'GiftTransaction', fieldApiName: 'Status', values: ['Paid', 'Completed'] }]
    }),
    createArchitecturePlan: async (input) => {
      plannerCalls.push(input);
      if (!input.answers.some((answer) => answer.text === 'Paid' && answer.ambiguityId === 'material:status-values')) {
        throw Object.assign(new Error('Confirm whether Paid or Completed is the verified qualifying status before planning.'), {
          code: 'MATERIAL_CLARIFICATION_REQUIRED',
          ambiguityId: 'material:status-values'
        });
      }
      return { ...plan(), evidenceIds: ['evidence:relationship', 'evidence:status-paid'] };
    }
  });
  t.after(() => setDirectAnalysisDependenciesForTest());

  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'When a Donation becomes Paid or Completed, number it.'
  });
  await updateJob(jobId, { orgContext: orgContext() });
  await appendConversation(jobId, { role: 'user', kind: 'requirement', text: 'When a Donation becomes Paid or Completed, number it.', actor: '005g5000009ImIkAAK' });

  await processAgentJob({ jobId, action: 'understand', actor: '005g5000009ImIkAAK' });
  let updated = await getJobRecord(jobId);
  assert.equal(updated.status, 'AWAITING_CLARIFICATION');
  assert.equal(updated.clarifications[0].ambiguityId, 'material:status-values');

  await appendConversation(jobId, {
    role: 'user',
    kind: 'clarification-response',
    text: 'Paid',
    actor: '005g5000009ImIkAAK',
    ambiguityId: 'material:status-values',
    responseToInspectionHash: updated.inspection.hash,
    responseToPlanVersion: updated.iteration
  });

  await processAgentJob({ jobId, action: 'understand', actor: '005g5000009ImIkAAK' });
  updated = await getJobRecord(jobId);
  assert.equal(updated.status, 'AWAITING_IMPLEMENTATION_APPROVAL');
  assert.deepEqual(plannerCalls.at(-1).answers, [{
    ambiguityId: 'material:status-values',
    text: 'Paid',
    inspectionHash: updated.inspection.hash,
    planVersion: updated.iteration
  }]);
});

test('direct planning controlled failures leave planning with sanitized failed state', async (t) => {
  for (const scenario of [
    { name: 'model failure', modelRunner: async () => { throw Object.assign(new Error('raw model stack public class Secret {}'), { code: 'PLANNING_MODEL_FAILED' }); } },
    { name: 'timeout', modelRunner: async () => { throw Object.assign(new Error('model timeout'), { code: 'PLANNING_MODEL_TIMEOUT' }); } },
    { name: 'schema failure', modelRunner: async () => ({ ...plan(), fileOperations: [{ path: 'force-app/main/default/flows/Evil.flow-meta.xml', content: '<Flow/>' }] }) },
    { name: 'unknown evidence', modelRunner: async () => ({ ...plan(), evidenceIds: ['evidence:missing'] }) }
  ]) {
    const jobId = `direct-failure-${scenario.name.replace(/\s+/g, '-')}-${Date.now()}`;
    setDirectAnalysisDependenciesForTest({
      inspectFlowRequirement: async () => inspection(),
      architecturePlannerDependencies: { modelRunner: scenario.modelRunner }
    });

    await createJobRecord({
      jobId,
      userId: '005g5000009ImIkAAK',
      orgId: '00Dg500000E07e9EAB',
      source: 'salesforce-chat',
      prompt: 'Create a recurring donation installment Flow.'
    });
    await updateJob(jobId, { orgContext: orgContext() });

    const result = await processAgentJob({ jobId, action: 'understand', actor: '005g5000009ImIkAAK' });
    const updated = await getJobRecord(jobId);

    assert.equal(result.status, 'FAILED', scenario.name);
    assert.equal(updated.status, 'FAILED', scenario.name);
    assert.equal(updated.plan, null, scenario.name);
    assert.equal(updated.commands.length, 0, scenario.name);
    assert.equal(updated.approvals.length, 0, scenario.name);
    assert.equal(JSON.stringify(updated).includes('<Flow'), false, scenario.name);
    assert.equal(/public class|Secret|stack/i.test(updated.error), false, scenario.name);
  }
  t.after(() => setDirectAnalysisDependenciesForTest());
});

test('legacy Jira analysis remains isolated from direct architecture planner', async (t) => {
  const jobId = `jira-legacy-${Date.now()}`;
  let plannerCalled = false;
  setDirectAnalysisDependenciesForTest({
    createArchitecturePlan: async () => {
      plannerCalled = true;
      return plan();
    }
  });
  t.after(() => setDirectAnalysisDependenciesForTest());

  await createJobRecord({
    jobId,
    userId: 'jira-webhook',
    source: 'jira-webhook',
    jiraIssueKey: 'SAPA-123',
    prompt: 'Analyze Jira issue SAPA-123'
  });

  await assert.rejects(
    () => processAgentJob({ jobId, action: 'analyze', actor: 'jira-webhook' }),
    /Jira workflows are disabled/
  );
  assert.equal(plannerCalled, false);
});

function orgContext() {
  return {
    orgRegistryId: 'providus_orgfarm_dev',
    expectedOrgId: '00Dg500000E07e9EAB',
    environment: 'developer',
    salesforceAlias: 'orgfarm-dev',
    verified: { organizationId: '00Dg500000E07e9EAB', verifiedAt: new Date().toISOString() }
  };
}

function inspection() {
  const body = {
    sourceOrgId: '00Dg500000E07e9EAB',
    evidence: [{
      evidenceId: 'evidence:relationship',
      kind: 'RELATIONSHIP',
      objectApiName: 'GiftTransaction',
      fieldApiName: 'GiftCommitmentId',
      targetObjectApiName: 'GiftCommitment',
      componentType: 'CustomField',
      componentApiName: 'GiftTransaction.GiftCommitmentId',
      sourceOrgId: '00Dg500000E07e9EAB',
      active: true,
      observedAt: new Date().toISOString()
    }],
    objects: [{ apiName: 'GiftTransaction' }],
    relationships: [{ objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', referenceTo: 'GiftCommitment' }],
    ambiguities: []
  };
  return { ...body, hash: canonicalInspectionHash(body) };
}

function plan() {
  return {
    requirement: 'Create a recurring donation installment Flow.',
    acceptanceCriteria: ['Only paid donations are numbered.'],
    assumptions: [],
    evidenceIds: ['evidence:relationship'],
    components: [{ operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Implement the requested behavior.' }],
    expectedBehavior: ['Paid donations are numbered.'],
    testingStrategy: ['Validate the Flow in the verified sandbox.'],
    risks: [],
    rollbackStrategy: 'Disable generated metadata before deployment.',
    planVersion: 1,
    planHash: 'plan-hash',
    scopeHash: 'scope-hash',
    materialChangeHash: 'scope-hash'
  };
}
