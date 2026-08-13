import test from 'node:test';
import assert from 'node:assert/strict';
import { architecturePlanHashes } from '../src/domain/architecturePlan.js';
import { canonicalInspectionHash } from '../src/domain/inspection.js';
import { processAgentJob, setDirectAnalysisDependenciesForTest, setDirectSpecialistModelRunnerForTest, setImplementationBaselineRunnerForTest, setSameOrgResolverForTest } from '../src/services/agent.js';
import { appendConversation, createJobRecord, getJobRecord, updateJob } from '../src/services/jobStore.js';

test.beforeEach(() => {
  setSameOrgResolverForTest(async ({ authenticatedOrgId }) => orgContext(authenticatedOrgId));
  setImplementationBaselineRunnerForTest(async ({ job, operations }) => {
    const baseline = {
      status: 'CAPTURED', sourceWritten: false,
      baselineCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      componentKeys: job.plan.components.map((component) => `${component.metadataType}:${component.apiName}`).sort(),
      files: operations.map((operation) => ({ path: operation.path, state: operation.operation === 'create' ? 'ABSENT' : 'PRESENT', ...(operation.operation === 'create' ? {} : { hash: 'b'.repeat(64) }) })),
      sourceOrgId: job.sourceValidation.sourceOrgId,
      planHash: job.sourceValidation.planHash,
      scopeHash: job.sourceValidation.scopeHash,
      inspectionHash: job.sourceValidation.inspectionHash,
      sourceHash: job.sourceValidation.sourceHash
    };
    await updateJob(job.jobId, { implementationBaseline: baseline });
    return baseline;
  });
});

test.afterEach(() => {
  setSameOrgResolverForTest();
  setDirectSpecialistModelRunnerForTest();
  setImplementationBaselineRunnerForTest();
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
        { evidenceId: 'evidence:status-paid', kind: 'STATUS_VALUE', objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Paid', componentType: 'CustomField', componentApiName: 'GiftTransaction.Status', sourceOrgId: '00Dg500000E07e9EAB', active: true, stale: false, observedAt: '2026-08-12T00:00:00.000Z' }
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

test('blocked bounded specialist records trusted clarification instead of failing or writing source', async () => {
  const jobId = `specialist-blocked-${Date.now()}`;
  const currentInspection = inspection();
  const currentPlan = actionPlan(currentInspection);
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a recurring donation installment Flow.'
  });
  await updateJob(jobId, {
    status: 'IMPLEMENTING',
    inspection: currentInspection,
    plan: currentPlan,
    metadataScope: { hash: currentPlan.scopeHash, source: 'architecture-plan', components: currentPlan.components },
    orgContext: orgContext(),
    approvals: [implementationApproval(currentPlan)]
  });
  setDirectSpecialistModelRunnerForTest(async () => blockedFlowResult());

  const result = await processAgentJob({ jobId, action: 'implement', actor: '005g5000009ImIkAAK' });
  const updated = await getJobRecord(jobId);

  assert.equal(result.status, 'AWAITING_CLARIFICATION');
  assert.equal(result.specialistStatus, 'BLOCKED');
  assert.equal(updated.status, 'AWAITING_CLARIFICATION');
  assert.equal(updated.error, '');
  assert.equal(Boolean(updated.implementation), false);
  assert.equal(Boolean(updated.validation), false);
  assert.equal(Boolean(updated.deployment), false);
  assert.deepEqual(updated.commands, []);
  assert.equal(updated.specialistResults.FLOW.status, 'BLOCKED');
  assert.deepEqual(updated.specialistResults.FLOW.operations, []);
  assert.equal(updated.clarifications.length, 1);
  const clarification = updated.clarifications[0];
  assert.equal(clarification.ambiguityId, 'specialist:FLOW:blocked:v1');
  assert.equal(clarification.specialistId, 'FLOW');
  assert.equal(clarification.question, 'Strict concurrent uniqueness requires a locking-capable Apex scope decision.');
  assert.equal(clarification.inspectionHash, currentInspection.hash);
  assert.equal(clarification.sourceOrgId, '00Dg500000E07e9EAB');
  assert.equal(clarification.planVersion, 1);
  assert.equal(clarification.planHash, currentPlan.planHash);
  assert.equal(clarification.scopeHash, currentPlan.scopeHash);
  assert.equal(clarification.status, 'OPEN');
});

test('direct implementation validates Task 8 results and captures a bound baseline before future local writes', async () => {
  const jobId = `specialist-completed-${Date.now()}`;
  const currentInspection = inspection();
  const currentPlan = actionPlan(currentInspection, {
    components: [
      { operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', owner: 'object-field-specialist', reason: 'Store installment sequence.' },
      { operation: 'modify', metadataType: 'PermissionSet', apiName: 'Gift_Operations', owner: 'security-specialist', reason: 'Grant exact field access.' },
      { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Assign installment sequence.' }
    ],
    evidenceIds: ['evidence:relationship', 'evidence:status-completed'],
    expectedBehavior: ['CREATE_AS_COMPLETED TRANSITION_TO_COMPLETED ALREADY_NUMBERED_PROTECTION SAME_PARENT_LOOKUP FIRST_INSTALLMENT_ONE INCREMENT_N_PLUS_ONE REVERSAL_RETENTION NO_HISTORICAL_RENUMBER NO_OVERWRITE.'],
    risks: ['Highest plus one cannot guarantee strict uniqueness under concurrent processing.']
  });
  const calls = [];
  setDirectSpecialistModelRunnerForTest(async (input) => {
    calls.push(input);
    return completedSpecialistResult(input.specialistId);
  });
  await createJobRecord({
    jobId,
    userId: '005g5000009ImIkAAK',
    orgId: '00Dg500000E07e9EAB',
    source: 'salesforce-chat',
    prompt: 'Create a recurring donation installment Flow.'
  });
  await updateJob(jobId, {
    status: 'IMPLEMENTING',
    inspection: currentInspection,
    plan: currentPlan,
    metadataScope: { hash: currentPlan.scopeHash, source: 'architecture-plan', components: currentPlan.components },
    orgContext: orgContext(),
    approvals: [implementationApproval(currentPlan)]
  });

  const result = await processAgentJob({ jobId, action: 'implement', actor: '005g5000009ImIkAAK' });
  const updated = await getJobRecord(jobId);

  assert.equal(result.specialistStatus, 'COMPLETED');
  assert.equal(result.sourceWritten, false);
  assert.equal(result.sourceEligible, true);
  assert.deepEqual(calls.map((call) => call.specialistId), ['OBJECT_FIELD', 'SECURITY_PERMISSIONS', 'FLOW']);
  assert.deepEqual(calls.at(-1).dependencyResults.map((item) => item.specialistId), ['OBJECT_FIELD', 'SECURITY_PERMISSIONS']);
  assert.deepEqual(Object.keys(updated.specialistResults), ['OBJECT_FIELD', 'SECURITY_PERMISSIONS', 'FLOW']);
  assert.equal(Boolean(updated.implementation), false);
  assert.equal(Boolean(updated.validation), false);
  assert.equal(Boolean(updated.deployment), false);
  assert.deepEqual(updated.commands, []);
  assert.equal(updated.sourceValidation.status, 'PASSED');
  assert.equal(updated.sourceValidation.operationCount, 3);
  assert.match(updated.sourceValidation.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(result.implementationBaseline.sourceHash, updated.sourceValidation.sourceHash);
  assert.equal(result.implementationBaseline.sourceOrgId, currentPlan.trustedBinding.sourceOrgId);
  assert.deepEqual(result.implementationBaseline.componentKeys, ['CustomField:GiftTransaction.Installment_Number__c', 'Flow:Assign_Installment', 'PermissionSet:Gift_Operations']);
});

test('Task 9 rejects one malicious operation after complete specialist collection with zero write or Salesforce effects', async () => {
  const jobId = `source-validation-failure-${Date.now()}`;
  const currentInspection = inspection();
  const currentPlan = actionPlan(currentInspection, {
    components: [
      { operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', owner: 'object-field-specialist', reason: 'Store installment sequence.' },
      { operation: 'modify', metadataType: 'PermissionSet', apiName: 'Gift_Operations', owner: 'security-specialist', reason: 'Grant exact field access.' },
      { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Assign installment sequence.' }
    ],
    evidenceIds: ['evidence:relationship', 'evidence:status-completed']
  });
  setDirectSpecialistModelRunnerForTest(async (input) => {
    const output = completedSpecialistResult(input.specialistId);
    if (input.specialistId === 'OBJECT_FIELD') {
      output.operations[0].content = output.operations[0].content.replace('</CustomField>', '<description>Authorization: Bearer abcdefghijklmnopqrstuvwxyz</description></CustomField>');
    }
    return output;
  });
  await createJobRecord({ jobId, userId: '005g5000009ImIkAAK', orgId: '00Dg500000E07e9EAB', source: 'salesforce-chat', prompt: 'Create a recurring donation installment Flow.' });
  await updateJob(jobId, {
    status: 'IMPLEMENTING', inspection: currentInspection, plan: currentPlan,
    metadataScope: { hash: currentPlan.scopeHash, source: 'architecture-plan', components: currentPlan.components },
    orgContext: orgContext(), approvals: [implementationApproval(currentPlan)],
    sourceValidation: { status: 'PASSED', sourceHash: 'stale-write-eligibility' }
  });

  const result = await processAgentJob({ jobId, action: 'implement', actor: '005g5000009ImIkAAK' });
  const updated = await getJobRecord(jobId);

  assert.equal(result.status, 'FAILED');
  assert.equal(updated.status, 'FAILED');
  assert.match(updated.error, /source validation failed safely/i);
  assert.doesNotMatch(updated.error, /Bearer|abcdef|Authorization/i);
  assert.deepEqual(Object.keys(updated.specialistResults), ['OBJECT_FIELD', 'SECURITY_PERMISSIONS', 'FLOW']);
  assert.equal(Boolean(updated.sourceValidation), false);
  assert.equal(Boolean(updated.implementation), false);
  assert.equal(Boolean(updated.validation), false);
  assert.equal(Boolean(updated.deployment), false);
  assert.deepEqual(updated.commands, []);
  assert.deepEqual(updated.clarifications, []);
});

for (const scenario of [
  { name: 'model unavailable', run: async () => { throw Object.assign(new Error('secret prompt and C:\\private\\model.log'), { code: 'SPECIALIST_MODEL_UNAVAILABLE' }); } },
  { name: 'timeout', run: async () => { throw Object.assign(new Error('provider timeout with secret token'), { code: 'SPECIALIST_MODEL_TIMEOUT' }); } },
  { name: 'malformed JSON', run: async () => '{not-json' },
  { name: 'schema violation', run: async () => ({ status: 'COMPLETED', operations: [], unexpected: true }) },
  { name: 'malformed XML', run: async () => ({ ...completedSpecialistResult('OBJECT_FIELD'), operations: [{ ...completedSpecialistResult('OBJECT_FIELD').operations[0], content: '<?xml version="1.0"?><CustomField>' }] }) },
  { name: 'ownership violation', run: async () => completedSpecialistResult('FLOW') },
  { name: 'scope violation', run: async () => ({ ...completedSpecialistResult('OBJECT_FIELD'), operations: [{ ...completedSpecialistResult('OBJECT_FIELD').operations[0], apiName: 'GiftTransaction.Unapproved__c', path: 'force-app/main/default/objects/GiftTransaction/fields/Unapproved__c.field-meta.xml' }] }) },
  { name: 'path violation', run: async () => ({ ...completedSpecialistResult('OBJECT_FIELD'), operations: [{ ...completedSpecialistResult('OBJECT_FIELD').operations[0], path: 'force-app/main/default/objects/GiftTransaction/fields/../Unapproved.field-meta.xml' }] }) }
]) {
  test(`specialist ${scenario.name} fails safely without clarification or downstream side effects`, async () => {
    const jobId = `specialist-failure-${scenario.name.replace(/\W/g, '-')}-${Date.now()}`;
    const currentInspection = inspection();
    const currentPlan = actionPlan(currentInspection, {
      components: [{ operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', owner: 'object-field-specialist', reason: 'Store installment sequence.' }]
    });
    await createJobRecord({ jobId, userId: '005g5000009ImIkAAK', orgId: '00Dg500000E07e9EAB', source: 'salesforce-chat', prompt: 'Create a field.' });
    await updateJob(jobId, {
      status: 'IMPLEMENTING', inspection: currentInspection, plan: currentPlan,
      metadataScope: { hash: currentPlan.scopeHash, source: 'architecture-plan', components: currentPlan.components },
      orgContext: orgContext(), approvals: [implementationApproval(currentPlan)]
    });
    setDirectSpecialistModelRunnerForTest(scenario.run);

    const result = await processAgentJob({ jobId, action: 'implement', actor: '005g5000009ImIkAAK' });
    const updated = await getJobRecord(jobId);
    assert.equal(result.status, 'FAILED');
    assert.equal(updated.status, 'FAILED');
    assert.match(updated.error, /Specialist source generation failed safely/);
    assert.doesNotMatch(updated.error, /secret|private|token|<CustomField/i);
    assert.deepEqual(updated.clarifications, []);
    assert.deepEqual(updated.commands, []);
    assert.equal(Boolean(updated.implementation), false);
    assert.equal(Boolean(updated.validation), false);
    assert.equal(Boolean(updated.deployment), false);
  });
}

test('specialist clarification response replans and clears stale implementation approval', async (t) => {
  const jobId = `specialist-blocked-replan-${Date.now()}`;
  const currentInspection = inspection();
  const oldPlan = actionPlan(currentInspection);
  const plannerCalls = [];
  setDirectAnalysisDependenciesForTest({
    inspectFlowRequirement: async () => currentInspection,
    createArchitecturePlan: async (input) => {
      plannerCalls.push(input);
      return {
        ...actionPlan(currentInspection, {
          components: [
            ...oldPlan.components,
            { operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Lock_Key__c', owner: 'object-field-specialist', reason: 'Support the clarified locking-capable design.' }
          ],
          expectedBehavior: ['Paid donations are numbered after the clarified scope decision.']
        })
      };
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
  await updateJob(jobId, {
    status: 'IMPLEMENTING',
    inspection: currentInspection,
    plan: oldPlan,
    metadataScope: { hash: oldPlan.scopeHash, source: 'architecture-plan', components: oldPlan.components },
    orgContext: orgContext(),
    approvals: [implementationApproval(oldPlan)]
  });
  setDirectSpecialistModelRunnerForTest(async () => blockedFlowResult());

  await processAgentJob({ jobId, action: 'implement', actor: '005g5000009ImIkAAK' });
  let updated = await getJobRecord(jobId);
  assert.equal(updated.status, 'AWAITING_CLARIFICATION');

  await appendConversation(jobId, {
    role: 'user',
    kind: 'clarification-response',
    text: 'Expand scope for locking-capable Apex.',
    actor: '005g5000009ImIkAAK',
    ambiguityId: updated.clarifications[0].ambiguityId,
    responseToInspectionHash: updated.inspection.hash,
    responseToPlanVersion: updated.iteration
  });

  await processAgentJob({ jobId, action: 'understand', actor: '005g5000009ImIkAAK' });
  updated = await getJobRecord(jobId);

  assert.equal(updated.status, 'AWAITING_IMPLEMENTATION_APPROVAL');
  assert.equal(updated.approvals.length, 0);
  assert.notEqual(updated.plan.scopeHash, oldPlan.scopeHash);
  assert.deepEqual(plannerCalls.at(-1).answers, [{
    ambiguityId: 'specialist:FLOW:blocked:v1',
    text: 'Expand scope for locking-capable Apex.',
    inspectionHash: updated.inspection.hash,
    planVersion: updated.iteration
  }]);
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
      stale: false,
      observedAt: new Date().toISOString()
    }, {
      evidenceId: 'evidence:status-completed',
      kind: 'STATUS_VALUE',
      objectApiName: 'GiftTransaction',
      fieldApiName: 'Status',
      value: 'Completed',
      componentType: 'CustomField',
      componentApiName: 'GiftTransaction.Status',
      sourceOrgId: '00Dg500000E07e9EAB',
      active: true,
      stale: false,
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

function actionPlan(currentInspection = inspection(), overrides = {}) {
  const core = {
    requirement: 'Create a recurring donation installment Flow.',
    acceptanceCriteria: ['Only paid donations are numbered.'],
    assumptions: [],
    evidenceIds: ['evidence:relationship'],
    components: [{ operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Implement the requested behavior.' }],
    expectedBehavior: ['Paid donations are numbered.'],
    testingStrategy: ['Validate the Flow in the verified sandbox.'],
    risks: [],
    rollbackStrategy: 'Disable generated metadata before deployment.',
    trustedBinding: { inspectionHash: currentInspection.hash, sourceOrgId: '00Dg500000E07e9EAB' },
    planVersion: 1,
    ...overrides
  };
  const hashes = architectureHashes(core);
  return { ...core, planHash: hashes.planHash, scopeHash: hashes.scopeHash, materialChangeHash: hashes.scopeHash };
}

function implementationApproval(currentPlan) {
  return {
    approvalId: 'approval-1',
    approvalType: 'IMPLEMENTATION',
    decision: 'APPROVED',
    planVersion: currentPlan.planVersion,
    planHash: currentPlan.planHash,
    metadataScopeHash: currentPlan.scopeHash,
    salesforceOrganizationId: '00Dg500000E07e9EAB'
  };
}

function blockedFlowResult() {
  return {
    status: 'BLOCKED',
    operations: [],
    dependencies: [],
    risks: ['Strict concurrent uniqueness cannot be guaranteed by highest-plus-one Flow numbering.'],
    verification: ['No Salesforce source was generated or written.'],
    materialQuestion: 'Strict concurrent uniqueness requires a locking-capable Apex scope decision.'
  };
}

function completedSpecialistResult(specialistId) {
  if (specialistId === 'OBJECT_FIELD') {
    return completedOperation({
      operation: 'create',
      path: 'force-app/main/default/objects/GiftTransaction/fields/Installment_Number__c.field-meta.xml',
      content: '<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Installment_Number__c</fullName><label>Installment Number</label><precision>18</precision><scale>0</scale><type>Number</type></CustomField>',
      metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', reason: 'Store installment sequence.'
    });
  }
  if (specialistId === 'SECURITY_PERMISSIONS') {
    return completedOperation({
      operation: 'modify',
      path: 'force-app/main/default/permissionsets/Gift_Operations.permissionset-meta.xml',
      content: '<?xml version="1.0" encoding="UTF-8"?><PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><fieldPermissions><field>GiftTransaction.Installment_Number__c</field><readable>true</readable><editable>true</editable></fieldPermissions></PermissionSet>',
      metadataType: 'PermissionSet', apiName: 'Gift_Operations', reason: 'Grant exact field access.'
    });
  }
  const semantics = 'CREATE_AS_COMPLETED TRANSITION_TO_COMPLETED ALREADY_NUMBERED_PROTECTION SAME_PARENT_LOOKUP FIRST_INSTALLMENT_ONE INCREMENT_N_PLUS_ONE REVERSAL_RETENTION NO_HISTORICAL_RENUMBER NO_OVERWRITE';
  return completedOperation({
    operation: 'modify',
    path: 'force-app/main/default/flows/Assign_Installment.flow-meta.xml',
    content: `<?xml version="1.0" encoding="UTF-8"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>65.0</apiVersion><description>${semantics}</description><formulas><name>Next_Installment_Number</name><dataType>Number</dataType><expression>{!Highest_Same_Parent.Installment_Number__c} + 1</expression><scale>0</scale></formulas><recordLookups><name>Highest_Same_Parent</name><connector><targetReference>Has_Previous_Number</targetReference></connector><filters><field>GiftCommitmentId</field><operator>EqualTo</operator><value><elementReference>$Record.GiftCommitmentId</elementReference></value></filters><filters><field>Installment_Number__c</field><operator>IsNull</operator><value><booleanValue>false</booleanValue></value></filters><object>GiftTransaction</object><sortField>Installment_Number__c</sortField><sortOrder>Desc</sortOrder><getFirstRecordOnly>true</getFirstRecordOnly></recordLookups><decisions><name>Has_Previous_Number</name><defaultConnector><targetReference>Assign_First</targetReference></defaultConnector><rules><name>Increment_Previous</name><conditions><leftValueReference>Highest_Same_Parent.Id</leftValueReference><operator>IsNull</operator><rightValue><booleanValue>false</booleanValue></rightValue></conditions><connector><targetReference>Assign_Increment</targetReference></connector></rules></decisions><assignments><name>Assign_First</name><assignmentItems><assignToReference>$Record.Installment_Number__c</assignToReference><operator>Assign</operator><value><numberValue>1</numberValue></value></assignmentItems></assignments><assignments><name>Assign_Increment</name><assignmentItems><assignToReference>$Record.Installment_Number__c</assignToReference><operator>Assign</operator><value><elementReference>Next_Installment_Number</elementReference></value></assignmentItems></assignments><start><connector><targetReference>Highest_Same_Parent</targetReference></connector><filterLogic>and</filterLogic><filters><field>Status</field><operator>EqualTo</operator><value><stringValue>Completed</stringValue></value></filters><filters><field>Installment_Number__c</field><operator>IsNull</operator><value><booleanValue>true</booleanValue></value></filters><object>GiftTransaction</object><recordTriggerType>CreateAndUpdate</recordTriggerType><triggerType>RecordBeforeSave</triggerType><doesRequireRecordChangedToMeetCriteria>true</doesRequireRecordChangedToMeetCriteria></start><status>Draft</status></Flow>`,
    metadataType: 'Flow', apiName: 'Assign_Installment', reason: 'Assign installment sequence.'
  }, ['Highest plus one cannot guarantee strict uniqueness under concurrent processing.']);
}

function completedOperation(operation, risks = []) {
  if (operation.metadataType === 'Flow') {
    operation = { ...operation, content: operation.content.replace('</apiVersion>', '</apiVersion><label>Assign Installment</label><processType>AutoLaunchedFlow</processType>') };
  }
  return { status: 'COMPLETED', operations: [operation], dependencies: [], risks, verification: ['Complete source generated in memory.'] };
}

function architectureHashes(planBody) {
  return architecturePlanHashes(planBody);
}
