import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHITECTURE_PLAN_SCHEMA, architecturePlanHashes } from '../src/domain/architecturePlan.js';
import { canonicalInspectionHash } from '../src/domain/inspection.js';
import { inspectFlowRequirement } from '../src/services/orgInspectionService.js';
import { createArchitecturePlan, createProductionArchitecturePlannerDependencies } from '../src/services/architecturePlanner.js';
import { trustOrgContext } from '../src/services/orgContextTrust.js';

test('architecture plan contains behavior and components but no source', async () => {
  const plan = await createArchitecturePlan({
    requirement: requirement(),
    inspection: verifiedInspection(),
    orgContext: orgContext(),
    answers: ['Use Paid.']
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

test('production architecture planner dependencies invoke configured model executor', async () => {
  const calls = [];
  const dependencies = createProductionArchitecturePlannerDependencies({
    modelExecutor: async (...args) => {
      calls.push(args);
      return sourceFreePlan();
    }
  });

  const plan = await createArchitecturePlan({
    requirement: requirement(),
    inspection: verifiedInspection(),
    orgContext: orgContext(),
    answers: ['Paid']
  }, dependencies);

  assert.equal(calls.length, 1);
  assert.equal(plan.trustedBinding.sourceOrgId, ORG_ID);
  assert.equal(plan.trustedBinding.inspectionHash, verifiedInspection().hash);
});

test('real inspector output feeds planner with only model boundary stubbed', async () => {
  const inspection = await inspectFlowRequirement({
    requirement: requirement('When a Donation becomes Paid, number it.'),
    orgContext: fullTrustedContext()
  }, { sf: plannerSf(), clock: fixedClock, maxComponents: 8, maxObjects: 2 });

  const plan = await createArchitecturePlan({
    requirement: requirement('When a Donation becomes Paid, number it.'),
    inspection,
    orgContext: fullTrustedContext(),
    answers: []
  }, { modelRunner: deterministicModelRunner({ evidenceIds: ['relationship:GiftTransaction.GiftCommitmentId', 'statusValue:GiftTransaction.Status.Paid'] }), clock: fixedClock });

  assert.equal(inspection.sourceOrgId, ORG_ID);
  assert.equal(inspection.hash, canonicalInspectionHash(inspection));
  assert.equal(plan.trustedBinding.sourceOrgId, ORG_ID);
  assert.equal(plan.trustedBinding.inspectionHash, inspection.hash);
});

test('production architecture planner fails closed when no model executor is configured', async () => {
  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement(),
      inspection: verifiedInspection(),
      orgContext: orgContext(),
      answers: ['Paid']
    }),
    (error) => error.code === 'PLANNING_MODEL_UNAVAILABLE'
  );
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

test('schema rejects source-shaped values in every allowed component field', () => {
  const componentFieldPayloads = {
    metadataType: 'ApexClass',
    apiName: 'force-app/main/default/classes/Evil.cls',
    owner: 'flow-specialist; sf project deploy start',
    reason: '```xml\n<Flow></Flow>\n```'
  };

  for (const [field, value] of Object.entries(componentFieldPayloads)) {
    assert.throws(() => ARCHITECTURE_PLAN_SCHEMA.parse({
      ...sourceFreePlan(),
      components: [{ ...sourceFreePlan().components[0], [field]: value }]
    }), /Architecture plans must not contain|Invalid|Unsupported|source/i, field);
  }
});

test('schema rejects source-shaped values in every allowed plan string field', () => {
  const payloads = {
    requirement: 'public class Evil {}',
    acceptanceCriteria: ['Run sf project deploy start'],
    assumptions: ['git commit -m owned'],
    evidenceIds: ['force-app/main/default/classes/Evil.cls'],
    expectedBehavior: ['<script>alert(1)</script>'],
    testingStrategy: ['powershell.exe Invoke-WebRequest http://example.invalid'],
    risks: ['```javascript\nconst x = 1\n```'],
    rollbackStrategy: 'rm -rf force-app/main/default'
  };

  for (const [field, value] of Object.entries(payloads)) {
    assert.throws(() => ARCHITECTURE_PLAN_SCHEMA.parse({
      ...sourceFreePlan(),
      [field]: value
    }), /Architecture plans must not contain|Invalid evidence/i, field);
  }
});

test('schema allows benign business phrasing that mentions source records', () => {
  assert.doesNotThrow(() => ARCHITECTURE_PLAN_SCHEMA.parse({
    ...sourceFreePlan(),
    expectedBehavior: ['The source record remains unchanged until the approved Flow assigns an installment number.']
  }));
});

test('schema rejects multiline encoded and escaped executable payloads while preserving benign prose', () => {
  const malicious = [
    'Review first line\nsf project deploy start',
    'Line 1\nLine 2\nLine 3\nLine 4',
    'c2YgcHJvamVjdCBkZXBsb3kgc3RhcnQ=',
    'sf%20project%20deploy%20start',
    's\\u0066 project deploy start'
  ];
  for (const payload of malicious) {
    assert.throws(() => ARCHITECTURE_PLAN_SCHEMA.parse({ ...sourceFreePlan(), risks: [payload] }), /Architecture plans must not contain/i, payload);
  }
  assert.doesNotThrow(() => ARCHITECTURE_PLAN_SCHEMA.parse({ ...sourceFreePlan(), risks: ['Review the source record owner before changing status automation.'] }));
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
      orgContext: orgContext(),
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
      orgContext: orgContext(),
      answers: []
    }, { modelRunner: deterministicModelRunner({ evidenceIds: ['evidence:relationship', 'evidence:missing'] }) }),
    /unknown inspection evidence/i
  );
});

test('inspection evidence must bind to current verified org and inspection hash', async () => {
  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement(),
      inspection: verifiedInspection({ sourceOrgId: '00Dg500000E07fAEAR' }),
      orgContext: orgContext(),
      answers: ['Paid']
    }, { modelRunner: deterministicModelRunner() }),
    (error) => error.code === 'INSPECTION_ORG_MISMATCH'
  );

  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement(),
      inspection: verifiedInspection({
        evidence: [
          ...verifiedInspection().evidence,
          { evidenceId: 'evidence:other-org', kind: 'FIELD', objectApiName: 'GiftTransaction', fieldApiName: 'Status', componentType: 'CustomField', componentApiName: 'GiftTransaction.Status', sourceOrgId: '00Dg500000E07fAEAR', active: true, observedAt: new Date().toISOString() }
        ]
      }),
      orgContext: orgContext(),
      answers: ['Paid']
    }, { modelRunner: deterministicModelRunner({ evidenceIds: ['evidence:relationship', 'evidence:other-org'] }) }),
    (error) => error.code === 'EVIDENCE_ORG_MISMATCH'
  );
});

test('duplicated stale or missing-org evidence is rejected', async () => {
  for (const evidence of [
    [{ evidenceId: 'evidence:relationship', kind: 'RELATIONSHIP', sourceOrgId: ORG_ID }, { evidenceId: 'evidence:relationship', kind: 'FIELD', sourceOrgId: ORG_ID }],
    [{ evidenceId: 'evidence:missing-org', kind: 'FIELD' }],
    [{ evidenceId: 'evidence:stale', kind: 'FIELD', sourceOrgId: ORG_ID, stale: true }]
  ]) {
    await assert.rejects(
      () => createArchitecturePlan({
        requirement: requirement(),
        inspection: verifiedInspection({ evidence }),
        orgContext: orgContext(),
        answers: ['Paid']
      }, { modelRunner: deterministicModelRunner({ evidenceIds: evidence.map((item) => item.evidenceId) }) }),
      /evidence/i
    );
  }
});

test('paid and completed requirements require exact verified active status evidence', async () => {
  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement('When a Donation becomes Paid, number it.'),
      inspection: verifiedInspection({ evidence: [statusEvidence('Completed')], statusCandidates: [statusCandidate(['Completed'])] }),
      orgContext: orgContext(),
      answers: []
    }, { modelRunner: deterministicModelRunner({ evidenceIds: ['evidence:status-completed'] }) }),
    (error) => error.code === 'MATERIAL_CLARIFICATION_REQUIRED'
  );

  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement('When a Donation becomes Paid or Completed, number it.'),
      inspection: verifiedInspection({
        evidence: [statusEvidence('Paid'), statusEvidence('Completed')],
        statusCandidates: [statusCandidate(['Paid', 'Completed'])]
      }),
      orgContext: orgContext(),
      answers: []
    }, { modelRunner: deterministicModelRunner() }),
    (error) => error.code === 'MATERIAL_CLARIFICATION_REQUIRED'
  );

  const valid = await createArchitecturePlan({
    requirement: requirement('When a Donation reaches the selected status, number it.'),
    inspection: verifiedInspection({ evidence: [statusEvidence('Paid')], statusCandidates: [statusCandidate(['Paid'])] }),
    orgContext: orgContext(),
    answers: ['Use Paid.']
  }, { modelRunner: deterministicModelRunner({ evidenceIds: ['evidence:status-paid'] }) });
  assert.equal(valid.evidenceIds[0], 'evidence:status-paid');
});

test('empty or unknown inspection evidence is rejected', async () => {
  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement(),
      inspection: verifiedInspection({ evidence: [] }),
      orgContext: orgContext(),
      answers: []
    }, { modelRunner: deterministicModelRunner() }),
    /verified inspection evidence is required/i
  );

  await assert.rejects(
    () => createArchitecturePlan({
      requirement: requirement(),
      inspection: null,
      orgContext: orgContext(),
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
    components: [...sourceFreePlan().components, { operation: 'modify', metadataType: 'PermissionSet', apiName: 'Gift_Operations', owner: 'security-specialist', reason: 'Grant field access.' }]
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
  const inspection = {
    sourceOrgId: ORG_ID,
    objects: [{ apiName: 'GiftTransaction' }, { apiName: 'GiftCommitment' }],
    relationships: [{ objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', referenceTo: 'GiftCommitment', evidenceId: 'evidence:relationship' }],
    statusCandidates: [{ objectApiName: 'GiftTransaction', fieldApiName: 'Status', values: ['Paid'] }],
    evidence: [
      { evidenceId: 'evidence:relationship', kind: 'RELATIONSHIP', objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', targetObjectApiName: 'GiftCommitment', componentType: 'CustomField', componentApiName: 'GiftTransaction.GiftCommitmentId', sourceOrgId: ORG_ID, active: true, observedAt: new Date().toISOString() },
      { evidenceId: 'evidence:field-status', kind: 'FIELD', objectApiName: 'GiftTransaction', fieldApiName: 'Status', sourceOrgId: ORG_ID, active: true, observedAt: new Date().toISOString() },
      { evidenceId: 'evidence:status-paid', kind: 'STATUS_VALUE', objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Paid', sourceOrgId: ORG_ID, active: true, observedAt: new Date().toISOString() }
    ],
    ambiguities: [],
    ...overrides
  };
  try {
    return { ...inspection, hash: canonicalInspectionHash(inspection) };
  } catch {
    return { ...inspection, hash: 'invalid-inspection-hash' };
  }
}

function orgContext() {
  return {
    expectedOrgId: ORG_ID,
    verified: { organizationId: ORG_ID, verifiedAt: new Date().toISOString() }
  };
}

function fullTrustedContext() {
  return trustOrgContext({
    orgRegistryId: 'providus_orgfarm_dev',
    salesforceAlias: 'verified-alias',
    expectedOrgId: ORG_ID,
    environment: 'developer',
    instanceUrl: 'https://orgfarm-9914d7f2f7-dev-ed.develop.my.salesforce.com',
    allowedMetadataTypes: ['CustomObject', 'CustomField'],
    restrictedMetadataTypes: [],
    verified: { organizationId: ORG_ID, verifiedAt: '2026-08-12T00:00:00.000Z' }
  });
}

function plannerSf() {
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
      return { organizationId: ORG_ID };
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
        })
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

function statusEvidence(value, overrides = {}) {
  return {
    evidenceId: `evidence:status-${String(value).toLowerCase()}`,
    kind: 'STATUS_VALUE',
    objectApiName: 'GiftTransaction',
    fieldApiName: 'Status',
    value,
    sourceOrgId: ORG_ID,
    active: true,
    observedAt: new Date().toISOString(),
    ...overrides
  };
}

function statusCandidate(values) {
  return { objectApiName: 'GiftTransaction', fieldApiName: 'Status', values };
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

const ORG_ID = '00Dg500000E07e9EAB';
