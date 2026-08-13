import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  SPECIALIST_REQUEST_SCHEMA,
  SPECIALIST_RESULT_SCHEMA
} from '../src/domain/specialistContract.js';
import { runSpecialists } from '../src/services/specialistRunner.js';

const job = {
  jobId: 'job-specialists',
  source: 'salesforce-chat',
  orgId: '00D000000000001AAA',
  userId: '005000000000001AAA'
};

const workspace = {
  workspacePath: 'implementation/plan-v1/project',
  planVersion: 1
};

const inspection = {
  hash: 'inspection-hash',
  sourceOrgId: '00D000000000001AAA',
  evidence: [
    evidence('field:GiftTransaction.Installment_Number__c', 'FIELD', { objectApiName: 'GiftTransaction', fieldApiName: 'Installment_Number__c', componentType: 'CustomField', componentApiName: 'GiftTransaction.Installment_Number__c' }),
    evidence('permissionSet:Gift_Operations', 'RETRIEVED_COMPONENT', { componentType: 'PermissionSet', componentApiName: 'Gift_Operations', retrievedSource: '<PermissionSet/>' }),
    evidence('flow:Assign_Installment', 'RETRIEVED_COMPONENT', { componentType: 'Flow', componentApiName: 'Assign_Installment', retrievedSource: '<Flow/>' }),
    evidence('flow:Unrelated', 'RETRIEVED_COMPONENT', { componentType: 'Flow', componentApiName: 'Unrelated', retrievedSource: '<Flow/>' }),
    evidence('apex:Unrelated', 'RETRIEVED_COMPONENT', { componentType: 'Flow', componentApiName: 'UnrelatedApex', retrievedSource: '<Flow/>' })
  ]
};

function evidence(evidenceId, kind, fields) {
  return { evidenceId, kind, ...fields, sourceOrgId: '00D000000000001AAA', active: true, stale: false, observedAt: new Date().toISOString() };
}

test('runs Object/Field, Security, then Flow and isolates approved components by owner', async () => {
  const runners = {
    OBJECT_FIELD: fakeRunner('OBJECT_FIELD'),
    SECURITY_PERMISSIONS: fakeRunner('SECURITY_PERMISSIONS'),
    FLOW: fakeRunner('FLOW')
  };

  const result = await runSpecialists({ job, plan: flowVerticalPlan(), inspection, workspace }, { runners });

  assert.deepEqual(result.executionOrder, ['OBJECT_FIELD', 'SECURITY_PERMISSIONS', 'FLOW']);
  assert.deepEqual([
    runners.OBJECT_FIELD.calls[0].specialistId,
    runners.SECURITY_PERMISSIONS.calls[0].specialistId,
    runners.FLOW.calls[0].specialistId
  ], ['OBJECT_FIELD', 'SECURITY_PERMISSIONS', 'FLOW']);
  assert.ok(runners.FLOW.calls[0].approvedComponents.every((component) => component.owner === 'FLOW'));
  assert.deepEqual(
    runners.FLOW.calls[0].approvedComponents.map((component) => component.apiName),
    ['Assign_Installment']
  );
  assert.deepEqual(
    runners.FLOW.calls[0].dependencyResults.map((dependency) => dependency.specialistId),
    ['OBJECT_FIELD', 'SECURITY_PERMISSIONS']
  );
  assert.equal(runners.FLOW.calls[0].inspectionEvidence.some((evidence) => evidence.componentApiName === 'Unrelated'), false);
  assert.equal(runners.FLOW.calls[0].inspectionEvidence.some((item) => item.componentApiName === 'UnrelatedApex'), false);
  assert.deepEqual(Object.keys(result.resultsBySpecialist), ['OBJECT_FIELD', 'SECURITY_PERMISSIONS', 'FLOW']);
});

test('rejects a Flow specialist result that writes a permission set', async () => {
  const runners = {
    OBJECT_FIELD: fakeRunner('OBJECT_FIELD'),
    SECURITY_PERMISSIONS: fakeRunner('SECURITY_PERMISSIONS'),
    FLOW: async () => ({
      status: 'COMPLETED',
      operations: [{
        operation: 'modify',
        path: 'force-app/main/default/permissionsets/Gift_Operations.permissionset-meta.xml',
        content: '<PermissionSet/>',
        metadataType: 'PermissionSet',
        apiName: 'Gift_Operations',
        reason: 'Grant access from the Flow specialist.'
      }],
      dependencies: [],
      risks: [],
      verification: ['Rejected before source writes.']
    })
  };

  await assert.rejects(
    () => runSpecialists({ job, plan: flowVerticalPlan(), inspection, workspace }, { runners }),
    (error) => error.code === 'SPECIALIST_OWNERSHIP_VIOLATION' && /specialist ownership/i.test(error.message)
  );
});

test('strict result schema rejects model-controlled extra fields and execution authority', () => {
  assert.throws(
    () => SPECIALIST_RESULT_SCHEMA.parse({
      status: 'COMPLETED',
      operations: [],
      dependencies: [],
      risks: [],
      verification: [],
      targetOrg: 'changed-org',
      command: 'sf project deploy start'
    }),
    z.ZodError
  );
});

test('strict request schema excludes org, approval, command, and unrelated authority fields', () => {
  assert.throws(
    () => SPECIALIST_REQUEST_SCHEMA.parse({
      specialistId: 'FLOW',
      jobId: 'job-specialists',
      planVersion: 1,
      workspace,
      approvedComponents: [],
      planContext: { requirement: 'Create a Flow.', acceptanceCriteria: [], expectedBehavior: [], risks: [] },
      inspectionEvidence: [],
      dependencyResults: [],
      targetOrg: '00D000000000002AAA',
      approved: true,
      command: 'sf project deploy start'
    }),
    z.ZodError
  );
});

test('blocked specialist returns structured blocked outcome with no fabricated operations', async () => {
  const runners = {
    OBJECT_FIELD: async () => ({
      status: 'BLOCKED',
      operations: [],
      dependencies: [],
      risks: ['Cannot safely choose a number field scale.'],
      verification: [],
      materialQuestion: 'What scale should Installment_Number__c use?'
    }),
    SECURITY_PERMISSIONS: fakeRunner('SECURITY_PERMISSIONS'),
    FLOW: fakeRunner('FLOW')
  };

  const result = await runSpecialists({ job, plan: flowVerticalPlan(), inspection, workspace }, { runners });

  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.executionOrder, ['OBJECT_FIELD']);
  assert.equal(result.resultsBySpecialist.OBJECT_FIELD.status, 'BLOCKED');
  assert.deepEqual(result.resultsBySpecialist.OBJECT_FIELD.operations, []);
  assert.deepEqual(result.suppressedSpecialists, ['SECURITY_PERMISSIONS', 'FLOW']);
});

test('does not execute dependent specialists after an upstream BLOCKED result', async () => {
  let securityCalls = 0;
  let flowCalls = 0;
  const runners = {
    OBJECT_FIELD: async () => ({
      status: 'BLOCKED',
      operations: [],
      dependencies: [],
      risks: [],
      verification: [],
      materialQuestion: 'Which object is authoritative?'
    }),
    SECURITY_PERMISSIONS: async () => { securityCalls += 1; return completedResult(); },
    FLOW: async () => { flowCalls += 1; return completedResult(); }
  };

  await runSpecialists({ job, plan: flowVerticalPlan(), inspection, workspace }, { runners });

  assert.equal(securityCalls, 0);
  assert.equal(flowCalls, 0);
});

test('invalid dependency graphs fail deterministically', async () => {
  await assert.rejects(
    () => runSpecialists({ job, plan: flowVerticalPlan(), inspection, workspace }, {
      runners: allFakeRunners(),
      dependencyGraph: { OBJECT_FIELD: ['FLOW'], SECURITY_PERMISSIONS: ['OBJECT_FIELD'], FLOW: ['SECURITY_PERMISSIONS'] }
    }),
    (error) => error.code === 'SPECIALIST_DEPENDENCY_CYCLE'
  );

  await assert.rejects(
    () => runSpecialists({ job, plan: flowVerticalPlan(), inspection, workspace }, {
      runners: allFakeRunners(),
      dependencyGraph: { OBJECT_FIELD: [], SECURITY_PERMISSIONS: ['MISSING'], FLOW: ['SECURITY_PERMISSIONS'] }
    }),
    (error) => error.code === 'UNKNOWN_SPECIALIST_DEPENDENCY'
  );
});

test('rejects duplicate specialists before partial execution', async () => {
  await assert.rejects(
    () => runSpecialists({ job, plan: flowVerticalPlan(), inspection, workspace }, {
      runners: allFakeRunners(),
      requiredSpecialists: ['FLOW', 'FLOW']
    }),
    (error) => error.code === 'DUPLICATE_SPECIALIST'
  );
});

test('rejects operations outside the approved component scope', async () => {
  const runners = {
    OBJECT_FIELD: fakeRunner('OBJECT_FIELD'),
    SECURITY_PERMISSIONS: fakeRunner('SECURITY_PERMISSIONS'),
    FLOW: async () => ({
      status: 'COMPLETED',
      operations: [{
        operation: 'modify',
        path: 'force-app/main/default/flows/Other_Flow.flow-meta.xml',
        content: '<Flow/>',
        metadataType: 'Flow',
        apiName: 'Other_Flow',
        reason: 'Modify a Flow outside the approved plan.'
      }],
      dependencies: [],
      risks: [],
      verification: ['Rejected before source writes.']
    })
  };

  await assert.rejects(
    () => runSpecialists({ job, plan: flowVerticalPlan(), inspection, workspace }, { runners }),
    (error) => error.code === 'SPECIALIST_SCOPE_VIOLATION'
  );
});

test('persists specialist results separately through the unified JobStore abstraction when supplied', async () => {
  const updates = [];
  const jobStore = {
    async update(jobId, patch) {
      updates.push({ jobId, patch });
      return { ...job, ...patch };
    }
  };

  const result = await runSpecialists({ job, plan: flowVerticalPlan(), inspection, workspace }, {
    runners: allFakeRunners(),
    jobStore
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(updates.length, 3);
  assert.deepEqual(
    updates.map((update) => Object.keys(update.patch.specialistResults).at(-1)),
    ['OBJECT_FIELD', 'SECURITY_PERMISSIONS', 'FLOW']
  );
  assert.equal(updates[2].patch.specialistResults.FLOW.specialistId, 'FLOW');
});

test('current inspection evidence without a stored stale flag is normalized at the specialist boundary', async () => {
  const withoutStoredStale = { ...inspection, evidence: inspection.evidence.map(({ stale: _stale, ...item }) => item) };
  const calls = [];
  await runSpecialists({ job, plan: flowVerticalPlan(), inspection: withoutStoredStale, workspace }, { runners: {
    OBJECT_FIELD: fakeRunner('OBJECT_FIELD', calls),
    SECURITY_PERMISSIONS: fakeRunner('SECURITY_PERMISSIONS', calls),
    FLOW: fakeRunner('FLOW', calls)
  } });
  assert.ok(calls.every((call) => call.inspectionEvidence.every((item) => item.stale === false)));
});

function flowVerticalPlan() {
  return {
    requirement: 'Assign installment numbers for completed recurring donation payments.',
    acceptanceCriteria: ['The number is assigned only when the payment is completed.'],
    assumptions: [],
    evidenceIds: ['field:GiftTransaction.Installment_Number__c', 'permissionSet:Gift_Operations', 'flow:Assign_Installment', 'flow:Unrelated', 'apex:Unrelated'],
    components: [
      { operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', owner: 'object-field-specialist', reason: 'Store installment number.' },
      { operation: 'modify', metadataType: 'PermissionSet', apiName: 'Gift_Operations', owner: 'security-specialist', reason: 'Grant field access.' },
      { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Assign installment number.' }
    ],
    expectedBehavior: ['Number completed payments.'],
    testingStrategy: ['Verify completed and not completed payments.'],
    risks: [],
    rollbackStrategy: 'Remove generated metadata after approval.',
    trustedBinding: { inspectionHash: 'inspection-hash', sourceOrgId: '00D000000000001AAA' },
    planHash: 'plan-hash',
    scopeHash: 'scope-hash',
    planVersion: 1
  };
}

function allFakeRunners() {
  return {
    OBJECT_FIELD: fakeRunner('OBJECT_FIELD'),
    SECURITY_PERMISSIONS: fakeRunner('SECURITY_PERMISSIONS'),
    FLOW: fakeRunner('FLOW')
  };
}

function fakeRunner(specialistId, calls = []) {
  const runner = async (request) => {
    calls.push({ specialistId, ...request });
    return completedResult(request.approvedComponents[0]);
  };
  runner.calls = calls;
  return runner;
}

function completedResult(component = {}) {
  return {
    status: 'COMPLETED',
    operations: component.apiName ? [{
      operation: component.operation,
      path: pathFor(component),
      content: '',
      metadataType: component.metadataType,
      apiName: component.apiName,
      reason: component.reason
    }] : [],
    dependencies: [],
    risks: [],
    verification: ['Structured contract accepted.']
  };
}

function pathFor(component) {
  if (component.metadataType === 'CustomField') {
    const [objectName, fieldName] = component.apiName.split('.');
    return `force-app/main/default/objects/${objectName}/fields/${fieldName}.field-meta.xml`;
  }
  if (component.metadataType === 'PermissionSet') return `force-app/main/default/permissionsets/${component.apiName}.permissionset-meta.xml`;
  if (component.metadataType === 'Flow') return `force-app/main/default/flows/${component.apiName}.flow-meta.xml`;
  return `force-app/main/default/unknown/${component.apiName}`;
}
