import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyValidationFailure,
  correctMechanicalFailure,
  createCorrectionService
} from '../src/services/correctionService.js';
import { createMemoryJobStore } from '../src/persistence/jobStore.js';
import { createComponentLockService, componentKeysForPlan } from '../src/services/componentLockService.js';
import { validateSpecialistOperations } from '../src/validation/sourceValidator.js';
import { stableHash } from '../src/utils/hash.js';
import { connectedFlowXml } from './fixtures/connectedFlow.js';

test('classifies malformed Flow XML as mechanical', () => {
  assert.equal(classifyValidationFailure({
    code: 'METADATA_XML_MALFORMED',
    source: 'SOURCE_VALIDATION',
    component: {
      metadataType: 'Flow',
      apiName: 'Assign_Installment',
      path: 'force-app/main/default/flows/Assign_Installment.flow-meta.xml'
    },
    details: { line: 12, column: 4, message: 'Unexpected closing element.' }
  }), 'MECHANICAL');
});

test('classifies an unapproved required business field as material', () => {
  assert.equal(classifyValidationFailure({
    code: 'UNAPPROVED_FIELD_REQUIRED',
    source: 'SOURCE_VALIDATION',
    component: { metadataType: 'CustomField', apiName: 'GiftTransaction.New_Business_Field__c' },
    details: { requirement: 'A new business field is required.' }
  }), 'MATERIAL');
});

for (const code of [
  'METADATA_XML_STRUCTURE_INVALID',
  'METADATA_XML_ELEMENT_ORDER_INVALID',
  'SOURCE_COMPILE_SYNTAX',
  'MANIFEST_ENTRY_MISSING'
]) {
  test(`classifies trusted ${code} evidence as mechanical`, () => {
    assert.equal(classifyValidationFailure({ code, source: 'SOURCE_VALIDATION' }), 'MECHANICAL');
  });
}

for (const code of [
  'NEW_COMPONENT_REQUIRED',
  'BUSINESS_BEHAVIOR_CHANGE_REQUIRED',
  'SECURITY_SCOPE_EXPANSION_REQUIRED',
  'DATA_SCOPE_EXPANSION_REQUIRED',
  'UNRELATED_DEPENDENCY_REQUIRED'
]) {
  test(`classifies trusted ${code} evidence as material`, () => {
    assert.equal(classifyValidationFailure({ code, source: 'SOURCE_VALIDATION' }), 'MATERIAL');
  });
}

for (const code of [
  'VALIDATION_TIMEOUT',
  'SERVICE_UNAVAILABLE',
  'CLI_UNAVAILABLE',
  'SALESFORCE_API_UNAVAILABLE',
  'SALESFORCE_NETWORK_ERROR',
  'DATABASE_UNAVAILABLE',
  'QUEUE_UNAVAILABLE'
]) {
  test(`classifies trusted ${code} evidence as infrastructure`, () => {
    assert.equal(classifyValidationFailure({ code, source: 'VALIDATION_INFRASTRUCTURE' }), 'INFRASTRUCTURE');
  });
}

test('fails closed for an unknown failure code even when its text says XML', () => {
  assert.throws(
    () => classifyValidationFailure({ code: 'UNKNOWN_FAILURE', message: 'malformed XML' }),
    (error) => error.code === 'VALIDATION_FAILURE_UNCLASSIFIED'
  );
});

test('rejects a fourth mechanical correction cycle', async () => {
  await assert.rejects(
    () => correctMechanicalFailure({
      job: { correctionAttempt: 3 },
      failure: { code: 'METADATA_XML_MALFORMED', source: 'SOURCE_VALIDATION' },
      owner: 'FLOW',
      attempt: 4
    }),
    (error) => error.code === 'CORRECTION_LIMIT_REACHED'
  );
});

test('allows attempts one through three and persists a new complete-set source binding each time', async () => {
  const fixture = await correctionFixture();
  let modelCalls = 0;
  const service = createCorrectionService({
    jobStore: fixture.jobStore,
    modelRunner: async (input) => {
      modelCalls += 1;
      return completedCorrection({ ...input.currentFiles[0], content: `${input.currentFiles[0].content}\n` });
    }
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const before = await fixture.jobStore.get(fixture.jobId);
    const previousHash = before.sourceValidation.sourceHash;
    const result = await service.correctMechanicalFailure({
      job: before,
      failure: flowFailure(),
      owner: 'FLOW',
      attempt,
      lockToken: fixture.lockToken
    });
    assert.equal(result.attempt, attempt);
    assert.notEqual(result.sourceValidation.sourceHash, previousHash);
    assert.equal(result.sourceValidation.status, 'PASSED');
  }

  const persisted = await fixture.jobStore.get(fixture.jobId);
  assert.equal(persisted.correctionAttempt, 3);
  assert.equal(modelCalls, 3);
  await assert.rejects(
    () => service.correctMechanicalFailure({ job: persisted, failure: flowFailure(), owner: 'FLOW', attempt: 4, lockToken: fixture.lockToken }),
    (error) => error.code === 'CORRECTION_LIMIT_REACHED'
  );
  assert.equal(modelCalls, 3);
});

test('reserves a correction attempt atomically so concurrent workers cannot both own attempt one', async () => {
  const fixture = await correctionFixture();
  let releaseModel;
  const blockedModel = new Promise((resolve) => { releaseModel = resolve; });
  const service = createCorrectionService({
    jobStore: fixture.jobStore,
    modelRunner: async (input) => {
      await blockedModel;
      return completedCorrection({ ...input.currentFiles[0], content: `${input.currentFiles[0].content}\n` });
    }
  });
  const snapshot = await fixture.jobStore.get(fixture.jobId);
  const first = service.correctMechanicalFailure({ job: snapshot, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken });
  await waitFor(async () => Boolean((await fixture.jobStore.get(fixture.jobId)).correctionReservation));
  await assert.rejects(
    () => service.correctMechanicalFailure({ job: snapshot, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken }),
    (error) => error.code === 'CORRECTION_IN_PROGRESS' || error.code === 'STALE_REVISION'
  );
  releaseModel();
  await first;
  assert.equal((await fixture.jobStore.get(fixture.jobId)).correctionAttempt, 1);
});

test('derives the owner from the failed approved operation and rejects a wrong owner', async () => {
  const fixture = await correctionFixture();
  const service = createCorrectionService({ jobStore: fixture.jobStore, modelRunner: async () => { throw new Error('must not run'); } });
  const snapshot = await fixture.jobStore.get(fixture.jobId);
  await assert.rejects(
    () => service.correctMechanicalFailure({ job: snapshot, failure: flowFailure(), owner: 'OBJECT_FIELD', attempt: 1, lockToken: fixture.lockToken }),
    (error) => error.code === 'CORRECTION_OWNER_MISMATCH'
  );
  assert.equal((await fixture.jobStore.get(fixture.jobId)).correctionAttempt, 0);
});

for (const [metadataType, owner, operationIndex] of [
  ['CustomField', 'OBJECT_FIELD', 0],
  ['PermissionSet', 'SECURITY_PERMISSIONS', 1],
  ['Flow', 'FLOW', 2]
]) {
  test(`${metadataType} failure resolves only to ${owner}`, async () => {
    const fixture = await correctionFixture();
    let receivedOwner = '';
    const service = createCorrectionService({
      jobStore: fixture.jobStore,
      modelRunner: async (input) => {
        receivedOwner = input.specialistId;
        return completedCorrection({ ...input.currentFiles[0], content: `${input.currentFiles[0].content}\n` });
      }
    });
    const operation = fixture.input.operations[operationIndex];
    await service.correctMechanicalFailure({
      job: await fixture.jobStore.get(fixture.jobId),
      failure: operationFailure(operation),
      owner,
      attempt: 1,
      lockToken: fixture.lockToken
    });
    assert.equal(receivedOwner, owner);
  });
}

for (const [name, mutate, code] of [
  ['cross-owner PermissionSet output', (operation, fixture) => ({ ...fixture.input.operations[1], content: `${fixture.input.operations[1].content}\n` }), 'CORRECTION_OWNER_MISMATCH'],
  ['new Flow output', (operation) => ({ ...operation, apiName: 'Unapproved_Flow', path: 'force-app/main/default/flows/Unapproved_Flow.flow-meta.xml' }), 'CORRECTION_SCOPE_VIOLATION'],
  ['changed Flow path', (operation) => ({ ...operation, path: 'force-app/main/default/flows/Other.flow-meta.xml' }), 'CORRECTION_SCOPE_VIOLATION']
]) {
  test(`rejects ${name} without accepting corrected source`, async () => {
    const fixture = await correctionFixture();
    const before = await fixture.jobStore.get(fixture.jobId);
    const original = before.specialistResults.FLOW.operations[0];
    const service = createCorrectionService({
      jobStore: fixture.jobStore,
      modelRunner: async (input) => completedCorrection(mutate(input.currentFiles[0], fixture))
    });
    await assert.rejects(
      () => service.correctMechanicalFailure({ job: before, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken }),
      (error) => error.code === code
    );
    const after = await fixture.jobStore.get(fixture.jobId);
    assert.deepEqual(after.specialistResults.FLOW.operations[0], original);
    assert.equal(after.implementationBaseline.sourceWritten, false);
  });
}

test('sends only sanitized failed-owner files, immutable behavior, ownership, and relevant trusted context', async () => {
  const fixture = await correctionFixture({
    extraEvidence: [{
      evidenceId: 'unrelated-secret', kind: 'RETRIEVED_COMPONENT', sourceOrgId: ORG,
      componentType: 'ApexClass', componentApiName: 'Unrelated', retrievedSource: 'client_secret=do-not-send',
      active: true, stale: false, observedAt: new Date().toISOString()
    }]
  });
  let modelInput;
  const service = createCorrectionService({
    jobStore: fixture.jobStore,
    modelRunner: async (input) => {
      modelInput = input;
      return completedCorrection({ ...input.currentFiles[0], content: `${input.currentFiles[0].content}\n` });
    }
  });
  await service.correctMechanicalFailure({
    job: await fixture.jobStore.get(fixture.jobId),
    failure: { ...flowFailure(), details: { message: 'Authorization: Bearer super-secret-token', line: 4, env: 'DATABASE_URL=postgres://secret' } },
    owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken
  });
  assert.deepEqual(Object.keys(modelInput).sort(), ['approvedComponents', 'currentFiles', 'failure', 'originalApprovedBehavior', 'ownership', 'specialistId', 'trustedContext'].sort());
  assert.equal(modelInput.specialistId, 'FLOW');
  assert.deepEqual(modelInput.currentFiles.map((item) => item.path), [FLOW_PATH]);
  assert.deepEqual(modelInput.ownership, [{ path: FLOW_PATH, owner: 'FLOW' }]);
  assert.deepEqual(modelInput.originalApprovedBehavior.expectedBehavior, fixture.input.plan.expectedBehavior);
  const serialized = JSON.stringify(modelInput);
  assert.doesNotMatch(serialized, /PermissionSet|client_secret|super-secret-token|DATABASE_URL|postgres:\/\//i);
  assert.doesNotMatch(serialized, /unrelated-secret|Unrelated/);
  assert.match(serialized, /\[REDACTED\]/);
});

test('revalidates the complete operation set and persists a new Task 9 source hash only after pass', async () => {
  const fixture = await correctionFixture();
  const before = await fixture.jobStore.get(fixture.jobId);
  let validatedOperations;
  const service = createCorrectionService({
    jobStore: fixture.jobStore,
    validateOperations: (input) => {
      validatedOperations = input.operations;
      return validateSpecialistOperations(input);
    },
    modelRunner: async (input) => completedCorrection({ ...input.currentFiles[0], content: `${input.currentFiles[0].content}\n` })
  });
  const result = await service.correctMechanicalFailure({ job: before, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken });
  assert.equal(validatedOperations.length, 3);
  assert.equal(result.sourceValidation.operationCount, 3);
  assert.notEqual(result.sourceValidation.sourceHash, before.sourceValidation.sourceHash);
  assert.equal(result.sourceValidation.sourceHash, stableHash(validatedOperations));
  assert.deepEqual((await fixture.jobStore.get(fixture.jobId)).approvals.map((approval) => approval.approvalType || approval.type), ['IMPLEMENTATION']);
});

test('does not publish a new PASSED source marker when corrected output still fails Task 9', async () => {
  const fixture = await correctionFixture();
  const before = await fixture.jobStore.get(fixture.jobId);
  const service = createCorrectionService({
    jobStore: fixture.jobStore,
    modelRunner: async (input) => completedCorrection({ ...input.currentFiles[0], content: '<Flow>' })
  });
  await assert.rejects(
    () => service.correctMechanicalFailure({ job: before, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken }),
    (error) => error.code === 'SPECIALIST_XML_INVALID'
  );
  const after = await fixture.jobStore.get(fixture.jobId);
  assert.equal(after.sourceValidation.sourceHash, before.sourceValidation.sourceHash);
  assert.equal(after.sourceValidation.validatedAt, before.sourceValidation.validatedAt);
  assert.equal(after.correctionAttempt, 1);
});

test('requires current component leases and immutable exact-org baseline binding', async () => {
  const fixture = await correctionFixture();
  const service = createCorrectionService({
    jobStore: fixture.jobStore,
    modelRunner: async (input) => completedCorrection({ ...input.currentFiles[0], content: `${input.currentFiles[0].content}\n` })
  });
  await fixture.locks.releaseComponentLocks({ jobId: fixture.jobId, componentKeys: fixture.componentKeys, lockToken: fixture.lockToken });
  const snapshot = await fixture.jobStore.get(fixture.jobId);
  await assert.rejects(
    () => service.correctMechanicalFailure({ job: snapshot, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken }),
    (error) => error.code === 'COMPONENT_LOCK_LOST'
  );
  assert.equal((await fixture.jobStore.get(fixture.jobId)).correctionAttempt, 0);
});

for (const [name, patch] of [
  ['baseline commit', { baselineCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
  ['baseline org', { sourceOrgId: '00D000000000002AAA' }],
  ['baseline scope hash', { scopeHash: 'changed-scope' }]
]) {
  test(`rejects changed ${name} binding`, async () => {
    const fixture = await correctionFixture();
    const stale = await fixture.jobStore.get(fixture.jobId);
    await fixture.jobStore.update(fixture.jobId, { implementationBaseline: { ...stale.implementationBaseline, ...patch } });
    const service = createCorrectionService({ jobStore: fixture.jobStore, modelRunner: async () => { throw new Error('must not run'); } });
    await assert.rejects(
      () => service.correctMechanicalFailure({ job: stale, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken }),
      (error) => error.code === 'CORRECTION_BASELINE_STALE'
    );
  });
}

for (const [name, sourceValidationPatch] of [
  ['operation count', { operationCount: 2 }],
  ['validated paths', { validatedPaths: ['force-app/main/default/flows/Assign_Installment.flow-meta.xml'] }]
]) {
  test(`rejects a stale Task 9 ${name} binding before model execution`, async () => {
    const fixture = await correctionFixture();
    const current = await fixture.jobStore.get(fixture.jobId);
    await fixture.jobStore.update(fixture.jobId, { sourceValidation: { ...current.sourceValidation, ...sourceValidationPatch } });
    const snapshot = await fixture.jobStore.get(fixture.jobId);
    const service = createCorrectionService({ jobStore: fixture.jobStore, modelRunner: async () => { throw new Error('must not run'); } });
    await assert.rejects(
      () => service.correctMechanicalFailure({ job: snapshot, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken }),
      (error) => error.code === 'CORRECTION_SOURCE_STALE'
    );
    assert.equal((await fixture.jobStore.get(fixture.jobId)).correctionAttempt, 0);
  });
}

test('preserves plan, scope, inspection, org, approved components, and baseline across correction', async () => {
  const fixture = await correctionFixture();
  const before = await fixture.jobStore.get(fixture.jobId);
  const service = createCorrectionService({
    jobStore: fixture.jobStore,
    modelRunner: async (input) => completedCorrection({ ...input.currentFiles[0], content: `${input.currentFiles[0].content}\n` })
  });
  await service.correctMechanicalFailure({ job: before, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken });
  const after = await fixture.jobStore.get(fixture.jobId);
  assert.equal(after.plan.planHash, before.plan.planHash);
  assert.equal(after.plan.scopeHash, before.plan.scopeHash);
  assert.equal(after.inspection.hash, before.inspection.hash);
  assert.equal(after.orgId, before.orgId);
  assert.deepEqual(after.plan.components, before.plan.components);
  assert.deepEqual(after.implementationBaseline, before.implementationBaseline);
  assert.equal(after.validation, null);
});

test('model infrastructure failure clears its reservation without consuming an attempt or changing source', async () => {
  const fixture = await correctionFixture();
  const before = await fixture.jobStore.get(fixture.jobId);
  const service = createCorrectionService({
    jobStore: fixture.jobStore,
    modelRunner: async () => { throw Object.assign(new Error('timed out with token'), { code: 'SPECIALIST_MODEL_TIMEOUT' }); }
  });
  await assert.rejects(
    () => service.correctMechanicalFailure({ job: before, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken }),
    (error) => error.code === 'SPECIALIST_MODEL_TIMEOUT'
  );
  const after = await fixture.jobStore.get(fixture.jobId);
  assert.equal(after.correctionAttempt, 0);
  assert.equal(after.correctionReservation, null);
  assert.deepEqual(after.specialistResults, before.specialistResults);
  assert.deepEqual(after.sourceValidation, before.sourceValidation);
});

for (const [name, operationIndex, owner, mutate] of [
  ['Flow activation', 2, 'FLOW', (operation) => ({ ...operation, content: operation.content.replace('<status>Draft</status>', '<status>Active</status>') })],
  ['security privilege expansion', 1, 'SECURITY_PERMISSIONS', (operation) => ({ ...operation, content: operation.content.replace('</PermissionSet>', '<objectPermissions><object>Account</object><allowRead>true</allowRead></objectPermissions></PermissionSet>') })],
  ['field type change', 0, 'OBJECT_FIELD', (operation) => ({ ...operation, content: operation.content.replace('<type>Number</type>', '<type>Text</type>') })]
]) {
  test(`Task 9 rejects mechanical correction output attempting ${name}`, async () => {
    const fixture = await correctionFixture();
    const operation = fixture.input.operations[operationIndex];
    const before = await fixture.jobStore.get(fixture.jobId);
    const service = createCorrectionService({
      jobStore: fixture.jobStore,
      modelRunner: async (input) => completedCorrection(mutate(input.currentFiles[0]))
    });
    await assert.rejects(
      () => service.correctMechanicalFailure({ job: before, failure: operationFailure(operation), owner, attempt: 1, lockToken: fixture.lockToken }),
      (error) => /^FLOW_|^SPECIALIST_/.test(error.code)
    );
    const after = await fixture.jobStore.get(fixture.jobId);
    assert.deepEqual(after.specialistResults[owner].operations, before.specialistResults[owner].operations);
    assert.deepEqual(after.plan, before.plan);
    assert.equal(after.implementationBaseline.sourceWritten, false);
  });
}

test('strict correction result rejects scope mutation properties and malformed prose output', async () => {
  for (const rawResult of [
    { ...completedCorrection(validInput().operations[2]), planHash: 'changed-plan' },
    'Here is corrected Flow XML'
  ]) {
    const fixture = await correctionFixture();
    const before = await fixture.jobStore.get(fixture.jobId);
    const service = createCorrectionService({ jobStore: fixture.jobStore, modelRunner: async () => rawResult });
    await assert.rejects(
      () => service.correctMechanicalFailure({ job: before, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken }),
      (error) => error.code === 'CORRECTION_RESULT_INVALID'
    );
    const after = await fixture.jobStore.get(fixture.jobId);
    assert.equal(after.plan.planHash, before.plan.planHash);
    assert.deepEqual(after.specialistResults, before.specialistResults);
    assert.equal(after.correctionAttempt, 1);
  }
});

test('binding change during a failed correction invalidates authority without consuming the new plan attempt', async () => {
  const fixture = await correctionFixture();
  let releaseModel;
  const blockedModel = new Promise((resolve) => { releaseModel = resolve; });
  const service = createCorrectionService({
    jobStore: fixture.jobStore,
    modelRunner: async () => { await blockedModel; return 'malformed output'; }
  });
  const before = await fixture.jobStore.get(fixture.jobId);
  const correction = service.correctMechanicalFailure({ job: before, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken });
  await waitFor(async () => Boolean((await fixture.jobStore.get(fixture.jobId)).correctionReservation));
  await fixture.jobStore.update(fixture.jobId, { plan: { ...before.plan, planHash: 'changed-plan-hash' } });
  releaseModel();
  await assert.rejects(correction, (error) => error.code === 'CORRECTION_BASELINE_STALE');
  const after = await fixture.jobStore.get(fixture.jobId);
  assert.equal(after.correctionAttempt, 0);
  assert.deepEqual(after.specialistResults, before.specialistResults);
});

test('Task 9 binding change during a failed correction invalidates authority without consuming an attempt', async () => {
  const fixture = await correctionFixture();
  let releaseModel;
  const blockedModel = new Promise((resolve) => { releaseModel = resolve; });
  const service = createCorrectionService({
    jobStore: fixture.jobStore,
    modelRunner: async () => { await blockedModel; return 'malformed output'; }
  });
  const before = await fixture.jobStore.get(fixture.jobId);
  const correction = service.correctMechanicalFailure({ job: before, failure: flowFailure(), owner: 'FLOW', attempt: 1, lockToken: fixture.lockToken });
  await waitFor(async () => Boolean((await fixture.jobStore.get(fixture.jobId)).correctionReservation));
  await fixture.jobStore.update(fixture.jobId, {
    sourceValidation: { ...before.sourceValidation, validatedPaths: before.sourceValidation.validatedPaths.slice(1) }
  });
  releaseModel();
  await assert.rejects(correction, (error) => error.code === 'CORRECTION_BASELINE_STALE');
  const after = await fixture.jobStore.get(fixture.jobId);
  assert.equal(after.correctionAttempt, 0);
  assert.deepEqual(after.specialistResults, before.specialistResults);
});

async function correctionFixture({ extraEvidence = [] } = {}) {
  const input = validInput();
  input.plan = {
    ...input.plan,
    requirement: 'Assign installment numbers to completed recurring donations.',
    acceptanceCriteria: ['Preserve approved recurring-donation behavior.'],
    expectedBehavior: ['Create and update completed records without overwrite.'],
    risks: ['Highest plus one is not strictly concurrent.']
  };
  input.inspection = { ...input.inspection, evidence: [...input.inspection.evidence, ...extraEvidence] };
  const validated = validateSpecialistOperations(input);
  const jobStore = createMemoryJobStore();
  const jobId = `correction-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await jobStore.create({ jobId, source: 'salesforce-chat', orgId: ORG, userId: '005-user', prompt: input.plan.requirement });
  const specialistResults = Object.fromEntries(['OBJECT_FIELD', 'SECURITY_PERMISSIONS', 'FLOW'].map((specialistId) => [specialistId, {
    specialistId,
    status: 'COMPLETED',
    operations: input.operations.filter((operation) => input.ownership[operation.path] === specialistId),
    dependencies: [], risks: [], verification: [], completedAt: new Date().toISOString()
  }]));
  const sourceValidation = {
    status: 'PASSED', sourceHash: validated.sourceHash, operationCount: 3,
    validatedPaths: validated.operations.map((operation) => operation.path), sourceOrgId: ORG,
    inspectionHash: input.inspection.hash, planHash: input.plan.planHash, scopeHash: input.plan.scopeHash,
    validatedAt: new Date().toISOString()
  };
  const componentKeys = componentKeysForPlan(input.plan);
  const implementationBaseline = {
    status: 'CAPTURED', baselineCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    files: input.operations.map((operation) => ({ path: operation.path, state: operation.operation === 'create' ? 'ABSENT' : 'PRESENT', ...(operation.operation === 'create' ? {} : { hash: stableHash(`baseline:${operation.path}`) }) })),
    componentKeys, sourceOrgId: ORG, planHash: input.plan.planHash, scopeHash: input.plan.scopeHash,
    inspectionHash: input.inspection.hash, sourceHash: validated.sourceHash,
    workspacePath: 'implementation/plan-v1/lease-test/project', capturedAt: new Date().toISOString(), sourceWritten: false
  };
  await jobStore.update(jobId, {
    status: 'CORRECTING', orgContext: { expectedOrgId: ORG, orgRegistryId: 'sandbox' },
    plan: input.plan, metadataScope: { hash: input.plan.scopeHash }, inspection: input.inspection,
    approvals: [
      { type: 'IMPLEMENTATION', decision: 'APPROVED', planHash: input.plan.planHash, scopeHash: input.plan.scopeHash },
      { approvalType: 'DEPLOYMENT', decision: 'APPROVED', validationId: 'stale-validation' },
      { approvalType: 'DATA_OPERATION', decision: 'APPROVED', previewHash: 'stale-preview' }
    ],
    specialistResults, sourceValidation, implementationBaseline, validation: { status: 'FAILED' },
    correctionAttempt: 0, correctionReservation: null, correctionHistory: []
  });
  const locks = createComponentLockService({ jobStore });
  const acquisition = await locks.acquireComponentLocks({ jobId, componentKeys, leaseSeconds: 60 });
  return { input, jobStore, jobId, locks, componentKeys, lockToken: acquisition.lockToken };
}

function flowFailure() {
  return operationFailure(validInput().operations[2]);
}

function operationFailure(operation) {
  return {
    code: 'METADATA_XML_MALFORMED', source: 'SOURCE_VALIDATION',
    component: { metadataType: operation.metadataType, apiName: operation.apiName, path: operation.path },
    details: { line: 12, column: 4, message: 'Unexpected closing element.' }
  };
}

function completedCorrection(operation) {
  return { status: 'COMPLETED', operations: [operation], dependencies: [], risks: [], verification: ['Corrected source must pass deterministic validation.'] };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition.');
}

function validInput() {
  const operations = [
    {
      operation: 'create', path: FIELD_PATH, metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', reason: 'Store installment sequence.',
      content: '<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Installment_Number__c</fullName><label>Installment Number</label><precision>18</precision><scale>0</scale><type>Number</type></CustomField>'
    },
    {
      operation: 'modify', path: PERMISSION_PATH, metadataType: 'PermissionSet', apiName: 'Gift_Operations', reason: 'Grant exact field access.',
      content: '<?xml version="1.0" encoding="UTF-8"?><PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><fieldPermissions><field>GiftTransaction.Installment_Number__c</field><readable>true</readable><editable>true</editable></fieldPermissions></PermissionSet>'
    },
    {
      operation: 'modify', path: FLOW_PATH, metadataType: 'Flow', apiName: 'Assign_Installment', reason: 'Assign installment sequence.',
      content: connectedFlowXml().replace('</apiVersion>', '</apiVersion><label>Assign Installment</label><processType>AutoLaunchedFlow</processType>')
    }
  ];
  const plan = {
    components: [
      { operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', owner: 'object-field-specialist', reason: 'Store installment sequence.' },
      { operation: 'modify', metadataType: 'PermissionSet', apiName: 'Gift_Operations', owner: 'security-specialist', reason: 'Grant exact field access.' },
      { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Assign installment sequence.' }
    ],
    evidenceIds: ['relationship', 'status-completed'],
    trustedBinding: { inspectionHash: 'inspection-hash', sourceOrgId: ORG },
    planHash: 'plan-hash', scopeHash: 'scope-hash', planVersion: 1
  };
  const inspection = {
    hash: 'inspection-hash', sourceOrgId: ORG,
    evidence: [
      { evidenceId: 'relationship', kind: 'RELATIONSHIP', sourceOrgId: ORG, objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', targetObjectApiName: 'GiftCommitment', componentType: 'CustomField', componentApiName: 'GiftTransaction.GiftCommitmentId', active: true, stale: false, observedAt: new Date().toISOString() },
      { evidenceId: 'status-completed', kind: 'STATUS_VALUE', sourceOrgId: ORG, objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Completed', componentType: 'CustomField', componentApiName: 'GiftTransaction.Status', active: true, stale: false, observedAt: new Date().toISOString() }
    ]
  };
  return {
    operations, plan, inspection,
    ownership: { [FIELD_PATH]: 'OBJECT_FIELD', [PERMISSION_PATH]: 'SECURITY_PERMISSIONS', [FLOW_PATH]: 'FLOW' }
  };
}

const ORG = '00Dg500000E07e9EAB';
const FIELD_PATH = 'force-app/main/default/objects/GiftTransaction/fields/Installment_Number__c.field-meta.xml';
const PERMISSION_PATH = 'force-app/main/default/permissionsets/Gift_Operations.permissionset-meta.xml';
const FLOW_PATH = 'force-app/main/default/flows/Assign_Installment.flow-meta.xml';
