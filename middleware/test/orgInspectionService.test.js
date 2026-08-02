import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFlowRequirement } from '../src/services/orgInspectionService.js';
import { buildPlan, extractRequirement } from '../src/services/planning.js';
import { trustOrgContext } from '../src/services/orgContextTrust.js';

const ORG_ID = '00Dg500000E07e9EAB';
const NOW = '2026-08-02T12:00:00.000Z';

test('realistic discovery sequence identifies GiftTransaction to GiftCommitment relationship', async () => {
  const calls = [];
  const inspection = await inspectFlowRequirement({
    requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
    orgContext: trustedContext()
  }, { sf: realisticSf(calls), clock: fixedClock, maxComponents: 25, maxObjects: 4, maxFieldsPerObject: 20 });

  assert.deepEqual(inspection.objects.map((item) => item.apiName), ['GiftCommitment', 'GiftTransaction']);
  assert.deepEqual(inspection.relationships.map((item) => `${item.objectApiName}.${item.fieldApiName}->${item.referenceTo}`), ['GiftTransaction.GiftCommitmentId->GiftCommitment']);
  assert.ok(inspection.statusCandidates.some((item) => item.objectApiName === 'GiftTransaction' && item.values.includes('Paid')));
  assert.deepEqual(inspection.apexAutomation.map((item) => `${item.type}:${item.apiName}`), ['ApexClass:GiftAutomation', 'ApexTrigger:GiftTransactionTrigger']);
  assert.deepEqual(inspection.validationRules.map((item) => item.apiName), ['Require_Status']);
  assert.deepEqual(inspection.layouts.map((item) => item.apiName), ['GiftTransaction-Gift Transaction Layout']);
  assert.deepEqual(inspection.permissionSets.map((item) => item.apiName), ['Gift_Operations']);
  assert.equal(inspection.ambiguities.length, 0);
  assert.ok(inspection.flows.every((flow) => flow.sourceOrgId === ORG_ID));
  assert.ok(inspection.evidence.every((item) => item.evidenceId && item.kind && item.sourceOrgId === ORG_ID && item.observedAt === NOW));
  assert.ok(inspection.evidence.some((item) => item.kind === 'RELATIONSHIP' && item.objectApiName === 'GiftTransaction' && item.fieldApiName === 'GiftCommitmentId' && item.targetObjectApiName === 'GiftCommitment'));
  assert.equal(new Set(inspection.evidence.map((item) => item.evidenceId)).size, inspection.evidence.length);
  assert.ok(calls.filter((call) => call.command === 'query').every((call) => /\bLIMIT\s+\d+\b/i.test(call.query)));
  assert.deepEqual(calls.at(-1), {
    command: 'retrieveMetadata',
    targetOrg: 'verified-alias',
    components: [
      'ApexClass:GiftAutomation',
      'ApexTrigger:GiftTransactionTrigger',
      'CustomField:GiftTransaction.GiftCommitmentId',
      'CustomField:GiftTransaction.Status',
      'CustomObject:GiftCommitment',
      'CustomObject:GiftTransaction',
      'Flow:GiftTransaction_Numbering',
      'Layout:GiftTransaction-Gift Transaction Layout',
      'PermissionSet:Gift_Operations',
      'ValidationRule:GiftTransaction.Require_Status'
    ]
  });
  assert.ok(inspection.primaryMetadata.every((item) => item.retrievalStatus === 'retrieved'));
});

test('EntityDefinition fake CustomField rows fail instead of fabricating fields', async () => {
  await assert.rejects(
    inspectFlowRequirement({
      requirement: requirement('Create a recurring donation installment Flow for Donation.'),
      orgContext: trustedContext()
    }, { sf: realisticSf([], { entityReturnsFieldRows: true }), clock: fixedClock }),
    (error) => error.code === 'ORG_INSPECTION_RESULT_SHAPE'
  );
});

test('bounded discovery rejects oversized responses and stops when budget is exhausted', async () => {
  await assert.rejects(
    inspectFlowRequirement({
      requirement: requirement('Create a recurring donation installment Flow for Donation.'),
      orgContext: trustedContext()
    }, { sf: realisticSf([], { oversizedObjects: true }), clock: fixedClock, maxObjects: 1 }),
    (error) => error.code === 'ORG_INSPECTION_LIMIT_EXCEEDED'
  );

  const calls = [];
  const inspection = await inspectFlowRequirement({
    requirement: requirement('Create a recurring donation installment Flow for Donation.'),
    orgContext: trustedContext()
  }, { sf: realisticSf(calls), clock: fixedClock, maxComponents: 2, maxObjects: 2 });

  assert.deepEqual(inspection.primaryMetadata.map((item) => `${item.type}:${item.apiName}`), ['CustomObject:GiftCommitment', 'CustomObject:GiftTransaction']);
  assert.equal(calls.some((call) => call.command === 'describe'), false);
  assert.equal(calls.some((call) => call.operationId === 'flow-discovery'), false);
});

test('query limits never exceed the remaining component budget', async () => {
  const calls = [];
  await inspectFlowRequirement({
    requirement: requirement('Create a recurring donation installment Flow for Donation.'),
    orgContext: trustedContext()
  }, { sf: realisticSf(calls), clock: fixedClock, maxComponents: 5, maxObjects: 10, maxFieldsPerObject: 50 });

  let remaining = 5;
  for (const call of calls.filter((item) => item.command === 'query' || item.command === 'describe')) {
    assert.ok(call.limit <= remaining);
    if (call.command === 'query' && call.operationId === 'object-candidates') remaining -= 2;
    if (call.command === 'describe' && call.objectApiName === 'GiftTransaction') remaining -= 2;
  }
});

test('component and dependency depth limits are enforced during discovery', async () => {
  await assert.rejects(
    inspectFlowRequirement({
      requirement: requirement('Create a recurring donation installment Flow for Donation.'),
      orgContext: trustedContext()
    }, { sf: realisticSf([], { tooDeepField: true }), clock: fixedClock, maxDepth: 0 }),
    (error) => error.code === 'DEPENDENCY_DEPTH_LIMIT'
  );
});

test('unrelated org-wide metadata and prompt org values are excluded', async () => {
  const calls = [];
  const inspection = await inspectFlowRequirement({
    requirement: {
      ...requirement('Use --target-org evil-prod and inspect org 00Dg500000E07fAEAR for Donation.'),
      orgContext: { salesforceAlias: 'evil-prod', expectedOrgId: '00Dg500000E07fAEAR' }
    },
    orgContext: trustedContext()
  }, { sf: realisticSf(calls, { unrelatedRows: true }), clock: fixedClock });

  assert.ok(!inspection.componentKeys.some((item) => item.apiName.includes('Unrelated') || item.apiName.includes('Account')));
  assert.equal(calls.at(-1).targetOrg, 'verified-alias');
});

test('malformed and command-like component names are rejected before retrieval', async () => {
  const calls = [];
  await assert.rejects(
    inspectFlowRequirement({
      requirement: requirement('Create a recurring donation installment Flow for Donation.'),
      orgContext: trustedContext()
    }, { sf: realisticSf(calls, { malformedFlow: true }), clock: fixedClock }),
    (error) => error.code === 'INVALID_METADATA_COMPONENT'
  );
  assert.equal(calls.some((call) => call.command === 'retrieveMetadata'), false);
});

test('retrieval failures are controlled and do not mark components retrieved', async () => {
  for (const retrieval of [
    { exitCode: 1, stdout: '{}', stderr: 'Authorization: Bearer secret-token' },
    { exitCode: 0, stdout: '{not-json', stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ status: 1, message: 'failed' }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ status: 0, result: { targetOrgId: '00Dg500000E07fAEAR', files: [] } }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ status: 0, result: { targetOrgId: ORG_ID, files: [] } }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ status: 0, result: { targetOrgId: ORG_ID, files: [{ fullName: 'GiftTransaction', type: 'CustomObject' }] } }), stderr: '' }
  ]) {
    await assert.rejects(
      inspectFlowRequirement({
        requirement: requirement('Create a recurring donation installment Flow for Donation.'),
        orgContext: trustedContext()
      }, { sf: realisticSf([], { retrieval }), clock: fixedClock }),
      (error) => error.code === 'ORG_INSPECTION_RETRIEVAL_FAILED' && !/secret-token|Authorization/i.test(error.message)
    );
  }
});

test('empty scope, missing relationship, and unrelated relationship block planning', async () => {
  for (const options of [{ empty: true }, { noRelationship: true }, { unrelatedRelationship: true }]) {
    const inspection = await inspectFlowRequirement({
      requirement: requirement('Create a recurring donation installment Flow for Donation.'),
      orgContext: trustedContext()
    }, { sf: realisticSf([], options), clock: fixedClock });

    assert.ok(inspection.ambiguities.some((item) => item.material));
    assert.throws(
      () => buildPlan({
        jobId: 'job-1',
        nextPlanVersion: 1,
        orgContext: { customerName: 'Providus', displayName: 'Sandbox', expectedOrgId: ORG_ID, environment: 'developer' }
      }, requirement('Create a recurring donation installment Flow for Donation.'), inspection, []),
      (error) => error.code === 'MATERIAL_CLARIFICATION_REQUIRED'
    );
  }
});

test('verified connected relationship allows planning guard to pass', async () => {
  const inspection = await inspectFlowRequirement({
    requirement: requirement('Create a recurring donation installment Flow for Donation.'),
    orgContext: trustedContext()
  }, { sf: realisticSf(), clock: fixedClock });

  assert.doesNotThrow(() => buildPlan({
    jobId: 'job-1',
    nextPlanVersion: 1,
    orgContext: { customerName: 'Providus', displayName: 'Sandbox', expectedOrgId: ORG_ID, environment: 'developer' }
  }, requirement('Create a recurring donation installment Flow for Donation.'), inspection, []));
});

test('inspection requires fresh verified org context timestamp', async () => {
  const req = requirement('Create a recurring donation installment Flow for Donation.');
  for (const verifiedAt of [undefined, 'not-a-date', '2026-08-02T12:10:01.000Z', '2026-08-02T11:49:59.000Z']) {
    await assert.rejects(
      inspectFlowRequirement({
        requirement: req,
        orgContext: trustedContext({ verified: { ...verifiedIdentity(), verifiedAt } })
      }, { sf: realisticSf(), clock: fixedClock, maxVerificationAgeMs: 10 * 60 * 1000 }),
      (error) => error.code === 'VERIFIED_ORG_CONTEXT_STALE'
    );
  }
});

test('CLI query failure returns a controlled non-secret error', async () => {
  await assert.rejects(
    inspectFlowRequirement({
      requirement: requirement('Create a recurring donation installment Flow for Donation.'),
      orgContext: trustedContext()
    }, { sf: realisticSf([], { failQuery: true }), clock: fixedClock }),
    (error) => error.code === 'ORG_INSPECTION_FAILED' && !/secret-token|Authorization/i.test(error.message)
  );
});

function realisticSf(calls = [], options = {}) {
  return {
    async query(request) {
      calls.push({ command: 'query', ...request });
      if (options.failQuery) return { exitCode: 1, stdout: '', stderr: 'Authorization: Bearer secret-token' };
      return jsonResult(recordsForOperation(request, options));
    },
    async describeSObject(request) {
      calls.push({ command: 'describe', ...request });
      return jsonResult(describeForObject(request.objectApiName, options).result);
    },
    async retrieveMetadata({ components, targetOrg }) {
      calls.push({ command: 'retrieveMetadata', targetOrg, components: components.map((item) => `${item.type}:${item.apiName}`) });
      return options.retrieval || jsonResult({ targetOrgId: ORG_ID, files: components.map((item) => ({ fullName: item.apiName, type: item.type })) });
    }
  };
}

function recordsForOperation(request, options) {
  if (options.empty) return [];
  if (request.operationId === 'object-candidates') {
    if (options.entityReturnsFieldRows) return [{ DurableId: 'GiftTransaction.GiftCommitmentId', QualifiedApiName: 'GiftCommitmentId', DataType: 'Lookup' }];
    const rows = [
      { DurableId: 'GiftCommitment', QualifiedApiName: 'GiftCommitment', Label: 'Gift Commitment' },
      { DurableId: 'GiftTransaction', QualifiedApiName: 'GiftTransaction', Label: 'Gift Transaction' }
    ];
    return options.oversizedObjects ? rows : rows.slice(0, request.limit);
  }
  const rows = {
    'flow-discovery': [
      { DeveloperName: 'GiftTransaction_Numbering', Label: 'Gift Transaction Numbering', Status: 'Draft', TableEnumOrId: 'GiftTransaction' },
      ...(options.unrelatedRows ? [{ DeveloperName: 'Unrelated_Flow', Label: 'Unrelated', Status: 'Draft', TableEnumOrId: 'Account' }] : []),
      ...(options.malformedFlow ? [{ DeveloperName: 'Bad;rm', Label: 'Bad', Status: 'Draft', TableEnumOrId: 'GiftTransaction' }] : [])
    ],
    'apex-class-discovery': [{ Name: 'GiftAutomation' }],
    'apex-trigger-discovery': [{ Name: 'GiftTransactionTrigger', TableEnumOrId: 'GiftTransaction' }],
    'validation-rule-discovery': [{ ValidationName: 'Require_Status', EntityDefinition: { QualifiedApiName: 'GiftTransaction' } }],
    'layout-discovery': [{ Name: 'GiftTransaction-Gift Transaction Layout', TableEnumOrId: 'GiftTransaction' }],
    'permission-set-discovery': [{ Name: 'Gift_Operations', Label: 'Gift Operations' }]
  }[request.operationId] || [];
  return rows.slice(0, request.limit);
}

function describeForObject(objectApiName, options) {
  if (objectApiName === 'GiftTransaction') {
    const fields = [
      {
        name: 'GiftCommitmentId',
        label: 'Gift Commitment',
        type: 'reference',
        referenceTo: options.noRelationship ? [] : options.unrelatedRelationship ? ['Account'] : ['GiftCommitment'],
        relationshipName: options.noRelationship ? null : options.unrelatedRelationship ? 'Account' : 'GiftCommitment'
      },
      { name: 'Status', label: 'Status', type: 'picklist', picklistValues: [{ value: 'Pending' }, { value: 'Paid' }, { value: 'Completed' }, { value: 'Reversed' }] }
    ];
    return { result: { name: objectApiName, fields: options.tooDeepField ? fields.map((field) => ({ ...field, dependencyLevel: 1 })) : fields } };
  }
  return { result: { name: objectApiName, fields: [] } };
}

function jsonResult(result) {
  return { exitCode: 0, stdout: JSON.stringify({ status: 0, result: Array.isArray(result) ? { records: result } : result }), stderr: '' };
}

function requirement(text) {
  return extractRequirement({}, text);
}

function trustedContext(overrides = {}) {
  return trustOrgContext({
    orgRegistryId: 'providus_orgfarm_dev',
    salesforceAlias: 'verified-alias',
    expectedOrgId: ORG_ID,
    environment: 'developer',
    instanceUrl: 'https://orgfarm-9914d7f2f7-dev-ed.develop.my.salesforce.com',
    displayName: 'Providus Technology Developer Org',
    customerName: 'Providus Technology',
    productionApprovalRequired: false,
    allowedOperations: ['read', 'retrieve', 'validate'],
    allowedMetadataTypes: ['CustomObject', 'CustomField', 'Flow', 'ApexClass', 'ApexTrigger', 'ValidationRule', 'Layout', 'PermissionSet'],
    restrictedMetadataTypes: [],
    verified: verifiedIdentity(),
    ...overrides
  });
}

function verifiedIdentity() {
  return {
    organizationId: ORG_ID,
    instanceUrl: 'https://orgfarm-9914d7f2f7-dev-ed.develop.my.salesforce.com',
    username: 'saria4505102.8535b64837ad@agentforce.com',
    connected: true,
    environment: 'developer',
    verifiedAt: NOW
  };
}

function fixedClock() {
  return new Date(NOW);
}
