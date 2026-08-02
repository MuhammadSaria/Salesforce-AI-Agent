import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHITECTURE_PLAN_SCHEMA, architecturePlanHashes } from '../src/domain/architecturePlan.js';
import { createArchitecturePlan } from '../src/services/architecturePlanner.js';

test('architecture plan contains behavior and components but no source', async () => {
  const plan = await createArchitecturePlan({
    requirement: requirement(),
    inspection: verifiedInspection(),
    answers: ['Use Paid as the completed donation status.']
  }, { modelRunner: deterministicModelRunner() });

  assert.equal(plan.components[0].metadataType, 'CustomField');
  assert.equal(plan.components.at(-1).metadataType, 'Flow');
  assert.deepEqual(plan.evidenceIds.sort(), ['evidence:field-status', 'evidence:relationship', 'evidence:status-paid']);
  assert.equal(JSON.stringify(plan).includes('<Flow'), false);
  assert.equal(JSON.stringify(plan).includes('public class'), false);
  assert.equal(JSON.stringify(plan).includes('sf project deploy'), false);
  assert.equal('fileOperations' in plan, false);
  assert.equal('content' in plan.components[0], false);
});

test('strict schema rejects unknown and source-generation fields', () => {
  const plan = sourceFreePlan();
  assert.throws(() => ARCHITECTURE_PLAN_SCHEMA.parse({ ...plan, fileOperations: [] }), /Unrecognized key/);
  assert.throws(() => ARCHITECTURE_PLAN_SCHEMA.parse({
    ...plan,
    components: [{ ...plan.components[0], content: '<Flow/>' }]
  }), /Unrecognized key/);
  assert.throws(() => ARCHITECTURE_PLAN_SCHEMA.parse({
    ...plan,
    generatedFiles: [{ path: 'force-app/main/default/flows/Test.flow-meta.xml', source: '<Flow/>' }]
  }), /Unrecognized key/);
});

test('paid-status ambiguity returns clarification rather than assumptions', async () => {
  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement('When a Donation becomes Paid or Completed, number it.'),
      inspection: verifiedInspection({
        evidence: verifiedInspection().evidence.filter((item) => item.kind !== 'STATUS_VALUE'),
        statusCandidates: [{ objectApiName: 'GiftTransaction', fieldApiName: 'Status', values: ['Paid', 'Completed'] }],
        ambiguities: [{
          ambiguityId: 'material:status-values',
          material: true,
          question: 'Confirm which verified status means completed.'
        }]
      }),
      answers: []
    }, { modelRunner: deterministicModelRunner() }),
    (error) => error.code === 'MATERIAL_CLARIFICATION_REQUIRED'
  );
});

test('evidence IDs must exist in inspection evidence', async () => {
  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement(),
      inspection: verifiedInspection(),
      answers: []
    }, { modelRunner: deterministicModelRunner({ evidenceIds: ['evidence:relationship', 'evidence:missing'] }) }),
    /unknown inspection evidence/i
  );
});

test('empty or unknown inspection evidence is rejected', async () => {
  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement(),
      inspection: verifiedInspection({ evidence: [] }),
      answers: []
    }, { modelRunner: deterministicModelRunner() }),
    /verified inspection evidence is required/i
  );

  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement(),
      inspection: null,
      answers: []
    }, { modelRunner: deterministicModelRunner() }),
    /verified inspection evidence is required/i
  );
});

test('architecture plan hash and scope hash are deterministic and source-free', () => {
  const hashes = architecturePlanHashes(sourceFreePlan());
  assert.equal(hashes.planHash, architecturePlanHashes(sourceFreePlan()).planHash);
  assert.equal(hashes.scopeHash, architecturePlanHashes({ ...sourceFreePlan(), assumptions: ['None.'] }).scopeHash);
  assert.notEqual(hashes.scopeHash, architecturePlanHashes({
    ...sourceFreePlan(),
    components: [...sourceFreePlan().components, { operation: 'modify', metadataType: 'PermissionSet', apiName: 'Gift_Operations', owner: 'security', reason: 'Grant field access.' }]
  }).scopeHash);
});

function deterministicModelRunner(overrides = {}) {
  return async () => ({
    ...sourceFreePlan(),
    ...overrides
  });
}

function requirement(text = 'Create a recurring donation installment Flow when Donation becomes Paid.') {
  return {
    summary: text,
    businessRequirement: text,
    acceptanceCriteria: ['Assign a sequential installment number only after a donation is paid.']
  };
}

function verifiedInspection(overrides = {}) {
  return {
    hash: 'inspection-hash',
    sourceOrgId: '00Dg500000E07e9EAB',
    objects: [{ apiName: 'GiftTransaction' }, { apiName: 'GiftCommitment' }],
    relationships: [{ objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', referenceTo: 'GiftCommitment', evidenceId: 'evidence:relationship' }],
    statusCandidates: [{ objectApiName: 'GiftTransaction', fieldApiName: 'Status', values: ['Paid'] }],
    evidence: [
      { evidenceId: 'evidence:relationship', kind: 'RELATIONSHIP', sourceOrgId: '00Dg500000E07e9EAB' },
      { evidenceId: 'evidence:field-status', kind: 'FIELD', objectApiName: 'GiftTransaction', fieldApiName: 'Status', sourceOrgId: '00Dg500000E07e9EAB' },
      { evidenceId: 'evidence:status-paid', kind: 'STATUS_VALUE', objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Paid', sourceOrgId: '00Dg500000E07e9EAB' }
    ],
    ambiguities: [],
    ...overrides
  };
}

function sourceFreePlan() {
  return {
    requirement: 'Create a recurring donation installment Flow when Donation becomes Paid.',
    acceptanceCriteria: ['Assign a sequential installment number only after a donation is paid.'],
    assumptions: [],
    evidenceIds: ['evidence:relationship', 'evidence:field-status', 'evidence:status-paid'],
    components: [
      { operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', owner: 'object-field-specialist', reason: 'Store the assigned installment number.' },
      { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Recurring_Donation_Installment', owner: 'flow-specialist', reason: 'Assign the next installment number after verified paid status.' }
    ],
    expectedBehavior: ['Paid donations connected to recurring donations receive a permanent installment number.'],
    testingStrategy: ['Validate positive, bulk, and missing-parent scenarios in the verified sandbox.'],
    risks: ['Concurrent completed donations can require locking-capable design to guarantee strict uniqueness.'],
    rollbackStrategy: 'Disable the generated inactive Flow version and remove generated metadata before deployment if approval is withdrawn.'
  };
}
