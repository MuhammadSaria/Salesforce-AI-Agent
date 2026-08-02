import test from 'node:test';
import assert from 'node:assert/strict';
import { processAgentJob, setDirectAnalysisDependenciesForTest } from '../src/services/agent.js';
import { createJobRecord, getJobRecord, updateJob } from '../src/services/jobStore.js';

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
  return {
    hash: 'inspection-hash',
    evidence: [{ evidenceId: 'evidence:relationship', kind: 'RELATIONSHIP', sourceOrgId: '00Dg500000E07e9EAB' }],
    objects: [{ apiName: 'GiftTransaction' }],
    relationships: [{ objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', referenceTo: 'GiftCommitment' }],
    ambiguities: []
  };
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
