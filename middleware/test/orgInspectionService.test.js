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
  assert.ok(calls.filter((call) => [
    'flow-discovery',
    'apex-class-discovery',
    'apex-trigger-discovery',
    'validation-rule-discovery',
    'layout-discovery',
    'permission-set-discovery'
  ].includes(call.operationId)).every((call) => call.useToolingApi === true));
  assert.ok(calls.find((call) => call.operationId === 'flow-discovery').query.includes('ApiName'));
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

test('large FieldDefinition result pages do not hide required fields', async () => {
  const calls = [];
  const inspection = await inspectFlowRequirement({
    requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
    orgContext: trustedContext()
  }, { sf: realisticSf(calls, { irrelevantFieldsBeforeRequired: true }), clock: fixedClock, maxComponents: 7, maxObjects: 2, maxFieldsPerObject: 3 });

  assert.deepEqual(inspection.relationships.map((item) => `${item.objectApiName}.${item.fieldApiName}->${item.referenceTo}`), ['GiftTransaction.GiftCommitmentId->GiftCommitment']);
  assert.ok(inspection.statusCandidates.some((item) => item.fieldApiName === 'Status' && item.values.includes('Paid')));
  assert.equal(inspection.primaryMetadata.length <= 7, true);
  assert.ok(calls.some((call) => call.operationId === 'field-definition-exact:GiftTransaction.GiftCommitmentId' && call.useToolingApi === true));
  assert.ok(calls.some((call) => call.operationId === 'field-definition-exact:GiftTransaction.Status' && call.useToolingApi === true));
  assert.equal(calls.some((call) => /\bDataType\s+IN\b/.test(call.query || '')), false);
  assert.equal(calls.some((call) => call.command === 'describe'), false);
});

test('missing deterministic field proof returns material ambiguity without retrieval', async () => {
  const calls = [];
  const inspection = await inspectFlowRequirement({
    requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
    orgContext: trustedContext()
  }, { sf: realisticSf(calls, { noRelationship: true }), clock: fixedClock, maxComponents: 25 });

  assert.ok(inspection.ambiguities.some((item) => item.material && item.ambiguityId === 'material:flow-object-relationship'));
  assert.equal(calls.some((call) => call.command === 'retrieveMetadata'), false);
});

test('status values are verified only from bounded PicklistValueInfo evidence', async () => {
  const calls = [];
  const inspection = await inspectFlowRequirement({
    requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
    orgContext: trustedContext()
  }, { sf: realisticSf(calls), clock: fixedClock, maxComponents: 25 });

  const picklistCall = calls.find((call) => call.operationId === 'picklist-values:GiftTransaction.Status');
  assert.ok(picklistCall.useToolingApi);
  assert.match(picklistCall.query, /SELECT EntityParticle\.EntityDefinition\.QualifiedApiName, EntityParticle\.QualifiedApiName, Value, Label, IsActive FROM PicklistValueInfo/);
  assert.match(picklistCall.query, /LIMIT\s+\d+/);
  assert.ok(inspection.statusCandidates.some((item) => item.fieldApiName === 'Status' && item.values.includes('Paid') && item.values.includes('Completed')));
  assert.ok(inspection.evidence.some((item) => item.kind === 'STATUS_VALUE' && item.objectApiName === 'GiftTransaction' && item.fieldApiName === 'Status' && item.value === 'Paid' && item.operationId === 'picklist-values:GiftTransaction.Status'));
});

test('missing or unusable picklist value evidence returns material ambiguity', async () => {
  for (const options of [{ noPicklistValues: true }, { noPaidCompletedValues: true }]) {
    const calls = [];
    const inspection = await inspectFlowRequirement({
      requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
      orgContext: trustedContext()
    }, { sf: realisticSf(calls, options), clock: fixedClock, maxComponents: 25 });

    assert.ok(inspection.ambiguities.some((item) => item.material && item.ambiguityId === 'material:status-values'));
    assert.equal(calls.some((call) => call.command === 'retrieveMetadata'), false);
  }
});

test('malformed or excessive picklist value responses are controlled failures', async () => {
  for (const options of [{ malformedPicklistValues: true }, { excessivePicklistValues: true }]) {
    await assert.rejects(
      inspectFlowRequirement({
        requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
        orgContext: trustedContext()
      }, { sf: realisticSf([], options), clock: fixedClock, maxComponents: 25 }),
      (error) => ['ORG_INSPECTION_RESULT_SHAPE', 'ORG_INSPECTION_LIMIT_EXCEEDED'].includes(error.code)
    );
  }
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
    if (call.command === 'query' && call.operationId === 'field-definition-exact:GiftTransaction.GiftCommitmentId') remaining -= 1;
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
    { exitCode: 0, stdout: JSON.stringify({ status: 0, result: {} }), stderr: '' },
    retrieveFilesResult([]),
    retrieveFilesResult([{ path: 'force-app/main/default/objects/GiftTransaction/GiftTransaction.object-meta.xml', state: 'Changed' }]),
    retrieveFilesResult([], { done: false, status: 'Canceled' }),
    retrieveFilesResult([{ path: 'force-app/main/default/objects/GiftTransaction/fields/GiftCommitmentId.field-meta.xml', state: 'Failed' }]),
    retrieveFilesResult([{ state: 'Changed' }]),
    retrieveFilesResult([{ path: 'force-app/main/default/staticresources/Unrelated.resource-meta.xml', state: 'Changed' }])
  ]) {
    await assert.rejects(
      inspectFlowRequirement({
        requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
        orgContext: trustedContext()
      }, { sf: realisticSf([], { retrieval }), clock: fixedClock }),
      (error) => error.code === 'ORG_INSPECTION_RETRIEVAL_FAILED' && !/secret-token|Authorization/i.test(error.message)
    );
  }
});

test('retrieval requires explicit supported successful result and file states', async () => {
  for (const retrieval of [
    retrieveFilesResult(successRetrieveFiles(), { status: undefined }),
    retrieveFilesResult(successRetrieveFiles(), { status: '' }),
    retrieveFilesResult(successRetrieveFiles(), { status: 'Complete' }),
    retrieveFilesResult(successRetrieveFiles(), { status: 'InProgress' }),
    retrieveFilesResult(successRetrieveFiles(), { status: 'Pending' }),
    retrieveFilesResult(successRetrieveFiles(), { status: 'Error' }),
    retrieveFilesResult(successRetrieveFiles(), { status: 'Errored' }),
    retrieveFilesResult(successRetrieveFiles(), { status: 'Failed' }),
    retrieveFilesResult(successRetrieveFiles(), { status: 'Canceled' }),
    retrieveFilesResult(successRetrieveFiles(), { status: 'Cancelled' }),
    retrieveFilesResult(successRetrieveFiles().map((file, index) => index === 0 ? { ...file, state: undefined } : file)),
    retrieveFilesResult(successRetrieveFiles().map((file, index) => index === 0 ? { ...file, state: '' } : file)),
    retrieveFilesResult(successRetrieveFiles().map((file, index) => index === 0 ? { ...file, state: 'Updated' } : file)),
    retrieveFilesResult(successRetrieveFiles().map((file, index) => index === 0 ? { ...file, state: 'InProgress' } : file)),
    retrieveFilesResult(successRetrieveFiles().map((file, index) => index === 0 ? { ...file, state: 'Pending' } : file)),
    retrieveFilesResult(successRetrieveFiles().map((file, index) => index === 0 ? { ...file, state: 'Error' } : file)),
    retrieveFilesResult(successRetrieveFiles().map((file, index) => index === 0 ? { ...file, state: 'Errored' } : file)),
    retrieveFilesResult(successRetrieveFiles().map((file, index) => index === 0 ? { ...file, state: 'Failed' } : file)),
    retrieveFilesResult(successRetrieveFiles().map((file, index) => index === 0 ? { ...file, state: 'Canceled' } : file)),
    retrieveFilesResult(successRetrieveFiles().map((file, index) => index === 0 ? { ...file, state: 'Cancelled' } : file))
  ]) {
    await assert.rejects(
      inspectFlowRequirement({
        requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
        orgContext: trustedContext()
      }, { sf: realisticSf([], { retrieval }), clock: fixedClock }),
      (error) => error.code === 'ORG_INSPECTION_RETRIEVAL_FAILED'
    );
  }
});

test('real Salesforce CLI result.files retrieve output is normalized to component evidence', async () => {
  const inspection = await inspectFlowRequirement({
    requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
    orgContext: trustedContext()
  }, { sf: realisticSf([], { retrieval: retrieveSuccessCliResult() }), clock: fixedClock });

  assert.ok(inspection.primaryMetadata.every((item) => item.retrievalStatus === 'retrieved'));
});

test('canonical Salesforce project paths are required for retrieval evidence', async () => {
  for (const files of [
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, path: '../classes/GiftAutomation.cls' } : file),
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, path: 'C:/outside/classes/GiftAutomation.cls' } : file),
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, path: 'other-root/main/default/classes/GiftAutomation.cls' } : file),
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, path: 'force-app//main/default/classes/GiftAutomation.cls' } : file),
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, path: 'force-app/main/default/classes/GiftAutomation.cls-meta.xml' } : file),
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, path: 'force-app/main/default/staticresources/GiftAutomation.resource-meta.xml' } : file)
  ]) {
    await assert.rejects(
      inspectFlowRequirement({
        requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
        orgContext: trustedContext()
      }, { sf: realisticSf([], { retrieval: retrieveFilesResult(files) }), clock: fixedClock }),
      (error) => error.code === 'ORG_INSPECTION_RETRIEVAL_FAILED'
    );
  }
});

test('canonical Salesforce project paths accept POSIX and Windows separators', async () => {
  for (const files of [
    successRetrieveFiles(),
    successRetrieveFiles().map((file) => ({ ...file, path: file.path.replaceAll('/', '\\') }))
  ]) {
    const inspection = await inspectFlowRequirement({
      requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
      orgContext: trustedContext()
    }, { sf: realisticSf([], { retrieval: retrieveFilesResult(files) }), clock: fixedClock });

    assert.ok(inspection.primaryMetadata.every((item) => item.retrievalStatus === 'retrieved'));
  }
});

test('result.files retrieval requires exact requested component evidence only', async () => {
  for (const files of [
    [...successRetrieveFiles(), { path: 'force-app/main/default/flows/Unexpected_Flow.flow-meta.xml', state: 'Changed' }],
    [...successRetrieveFiles(), { path: 'force-app/main/default/classes/UnexpectedClass.cls', state: 'Changed' }],
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, type: 'ApexClass', fullName: 'OtherClass' } : file),
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, path: 'force-app/main/default/bad/GiftAutomation.cls', type: 'ApexClass', fullName: 'GiftAutomation' } : file),
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, path: 'force-app/main/default/classes/OtherClass.cls', type: 'ApexClass', fullName: 'GiftAutomation' } : file),
    successRetrieveFiles().filter((file) => !file.path.includes('/flows/')),
    []
  ]) {
    await assert.rejects(
      inspectFlowRequirement({
        requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
        orgContext: trustedContext()
      }, { sf: realisticSf([], { retrieval: retrieveFilesResult(files) }), clock: fixedClock }),
      (error) => error.code === 'ORG_INSPECTION_RETRIEVAL_FAILED'
    );
  }
});

test('retrieval evidence requires complete type/fullName claims when claims are present', async () => {
  for (const files of [
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, type: 'ApexClass' } : file),
    successRetrieveFiles().map((file, index) => index === 0 ? { ...file, fullName: 'GiftAutomation' } : file),
    [{ type: 'ApexClass', state: 'Changed' }, ...successRetrieveFiles().slice(1)],
    [{ fullName: 'GiftAutomation', state: 'Changed' }, ...successRetrieveFiles().slice(1)]
  ]) {
    await assert.rejects(
      inspectFlowRequirement({
        requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
        orgContext: trustedContext()
      }, { sf: realisticSf([], { retrieval: retrieveFilesResult(files) }), clock: fixedClock }),
      (error) => error.code === 'ORG_INSPECTION_RETRIEVAL_FAILED'
    );
  }
});

test('consistent path and type/fullName result.files evidence is accepted', async () => {
  const files = successRetrieveFiles().map((file) => {
    const component = componentClaimForPath(file.path);
    return { ...file, type: component.type, fullName: component.apiName };
  });
  const inspection = await inspectFlowRequirement({
    requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
    orgContext: trustedContext()
  }, { sf: realisticSf([], { retrieval: retrieveFilesResult(files) }), clock: fixedClock });

  assert.ok(inspection.primaryMetadata.every((item) => item.retrievalStatus === 'retrieved'));
});

test('path-only valid result.files evidence is accepted', async () => {
  const inspection = await inspectFlowRequirement({
    requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
    orgContext: trustedContext()
  }, { sf: realisticSf([], { retrieval: retrieveFilesResult(successRetrieveFiles()) }), clock: fixedClock });

  assert.ok(inspection.primaryMetadata.every((item) => item.retrievalStatus === 'retrieved'));
});

test('duplicate result.files entries are deduplicated as component evidence', async () => {
  const retrieval = retrieveSuccessCliResult();
  const parsed = JSON.parse(retrieval.stdout);
  parsed.result.files = [...parsed.result.files, parsed.result.files[0], parsed.result.files[2]];
  retrieval.stdout = JSON.stringify(parsed);

  const inspection = await inspectFlowRequirement({
    requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
    orgContext: trustedContext()
  }, { sf: realisticSf([], { retrieval }), clock: fixedClock });

  assert.ok(inspection.primaryMetadata.every((item) => item.retrievalStatus === 'retrieved'));
});

test('conflicting duplicate result.files entries are rejected', async () => {
  for (const files of [
    [...successRetrieveFiles(), { path: 'force-app/main/default/classes/GiftAutomation.cls', type: 'ApexClass', fullName: 'OtherClass', state: 'Changed' }],
    [...successRetrieveFiles(), { path: 'force-app/main/default/classes/GiftAutomation.cls', state: 'Deleted' }],
    [...successRetrieveFiles(), { path: 'force-app/main/default/classes/GiftAutomation.cls', state: 'Changed', type: 'ApexClass', fullName: 'GiftAutomation' }],
    [...successRetrieveFiles(), { type: 'ApexClass', fullName: 'GiftAutomation', state: 'Changed' }]
  ]) {
    await assert.rejects(
      inspectFlowRequirement({
        requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
        orgContext: trustedContext()
      }, { sf: realisticSf([], { retrieval: retrieveFilesResult(files) }), clock: fixedClock }),
      (error) => error.code === 'ORG_INSPECTION_RETRIEVAL_FAILED'
    );
  }
});

test('fileResponses compatibility retrieve output remains accepted after same-org verification', async () => {
  const calls = [];
  const inspection = await inspectFlowRequirement({
    requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
    orgContext: trustedContext()
  }, { sf: realisticSf(calls, { retrieval: retrieveCompatibilityFileResponsesResult() }), clock: fixedClock });

  assert.ok(calls.some((call) => call.command === 'verifyOrg'));
  assert.ok(inspection.primaryMetadata.every((item) => item.retrievalStatus === 'retrieved'));
});

test('wrong org retrieval execution is rejected through verified org check', async () => {
  await assert.rejects(
    inspectFlowRequirement({
      requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
      orgContext: trustedContext()
    }, { sf: realisticSf([], { rejectRetrievalOrg: true }), clock: fixedClock }),
    (error) => error.code === 'ORG_VERIFICATION_FAILED'
  );
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
    requirement: requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'),
    orgContext: trustedContext()
  }, { sf: realisticSf(), clock: fixedClock });

  assert.doesNotThrow(() => buildPlan({
    jobId: 'job-1',
    nextPlanVersion: 1,
    orgContext: { customerName: 'Providus', displayName: 'Sandbox', expectedOrgId: ORG_ID, environment: 'developer' }
  }, requirement('When a Donation related to a Recurring Donation becomes Paid/Completed, assign its permanent sequential installment number.'), inspection, []));
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
      if (options.irrelevantFieldsBeforeRequired && /\bDataType\s+IN\b/.test(request.query || '')) {
        return jsonResult(irrelevantQualifyingFieldRowsBeforeRequired().slice(0, request.limit));
      }
      return jsonResult(recordsForOperation(request, options));
    },
    async verifyOrg() {
      calls.push({ command: 'verifyOrg', targetOrg: 'verified-alias' });
      if (options.rejectRetrievalOrg) {
        const error = new Error('Salesforce org verification failed.');
        error.code = 'ORG_VERIFICATION_FAILED';
        throw error;
      }
      return { organizationId: ORG_ID };
    },
    async retrieveMetadata({ components, targetOrg, orgContext }) {
      assert.equal(orgContext.expectedOrgId, ORG_ID);
      calls.push({ command: 'retrieveMetadata', targetOrg, components: components.map((item) => `${item.type}:${item.apiName}`) });
      return options.retrieval || retrieveSuccessForComponents(components);
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
  if (request.operationId?.startsWith('field-definition-exact:')) {
    const [, qualifiedName] = request.operationId.split(':');
    const [objectApiName, fieldApiName] = qualifiedName.split('.');
    return exactFieldDefinitionRows(objectApiName, fieldApiName, options).slice(0, request.limit);
  }
  if (request.operationId?.startsWith('picklist-values:')) {
    if (options.malformedPicklistValues) return [{ EntityParticle: { QualifiedApiName: 'Status' } }];
    const rows = picklistValueRows(options);
    return options.excessivePicklistValues ? [...rows, { ...rows[0], Value: 'Extra' }] : rows.slice(0, request.limit);
  }
  const rows = {
    'flow-discovery': [
      { ApiName: 'GiftTransaction_Numbering', Label: 'Gift Transaction Numbering', IsActive: true, ActiveVersion: { VersionNumber: 3 }, TriggerObjectOrEventLabel: 'Gift Transaction' },
      ...(options.unrelatedRows ? [{ ApiName: 'Unrelated_Flow', Label: 'Unrelated', IsActive: false, TriggerObjectOrEventLabel: 'Account' }] : []),
      ...(options.malformedFlow ? [{ ApiName: 'Bad;rm', Label: 'Bad', IsActive: false, TriggerObjectOrEventLabel: 'Gift Transaction' }] : [])
    ],
    'apex-class-discovery': [{ Name: 'GiftAutomation' }],
    'apex-trigger-discovery': [{ Name: 'GiftTransactionTrigger', TableEnumOrId: 'GiftTransaction' }],
    'validation-rule-discovery': [{ ValidationName: 'Require_Status', EntityDefinition: { QualifiedApiName: 'GiftTransaction' } }],
    'layout-discovery': [{ Name: 'GiftTransaction-Gift Transaction Layout', TableEnumOrId: 'GiftTransaction' }],
    'permission-set-discovery': [{ Name: 'Gift_Operations', Label: 'Gift Operations' }]
  }[request.operationId] || [];
  return rows.slice(0, request.limit);
}

function exactFieldDefinitionRows(objectApiName, fieldApiName, options) {
  if (objectApiName !== 'GiftTransaction') return [];
  if (fieldApiName === 'GiftCommitmentId') {
    if (options.noRelationship) return [];
    return [{
      EntityDefinition: { QualifiedApiName: 'GiftTransaction' },
      QualifiedApiName: 'GiftCommitmentId',
      Label: 'Gift Commitment',
      DataType: 'Lookup',
      ReferenceTo: options.unrelatedRelationship ? 'Account' : 'GiftCommitment',
      RelationshipName: options.unrelatedRelationship ? 'Account' : 'GiftCommitment',
      dependencyLevel: options.tooDeepField ? 1 : 0
    }];
  }
  if (fieldApiName !== 'Status') return [];
  return [
    {
      EntityDefinition: { QualifiedApiName: 'GiftTransaction' },
      QualifiedApiName: 'Status',
      Label: 'Status',
      DataType: 'Picklist'
    }
  ];
}

function irrelevantQualifyingFieldRowsBeforeRequired() {
  return [
    ...Array.from({ length: 10 }, (_, index) => ({
      EntityDefinition: { QualifiedApiName: 'GiftTransaction' },
      QualifiedApiName: `IrrelevantLookup${index}Id`,
      Label: `Irrelevant Lookup ${index}`,
      DataType: 'Lookup',
      ReferenceTo: 'Account',
      RelationshipName: `IrrelevantLookup${index}`
    })),
    ...exactFieldDefinitionRows('GiftTransaction', 'GiftCommitmentId', {}),
    ...exactFieldDefinitionRows('GiftTransaction', 'Status', {})
  ];
}

function picklistValueRows(options = {}) {
  if (options.noPicklistValues) return [];
  const values = options.noPaidCompletedValues ? ['Pending', 'Reversed'] : ['Pending', 'Paid', 'Completed', 'Reversed'];
  return values.map((value) => ({
    EntityParticle: {
      EntityDefinition: { QualifiedApiName: 'GiftTransaction' },
      QualifiedApiName: 'Status'
    },
    Value: value,
    Label: value,
    IsActive: true
  }));
}

function jsonResult(result) {
  return { exitCode: 0, stdout: JSON.stringify({ status: 0, result: Array.isArray(result) ? { records: result } : result }), stderr: '' };
}

function retrieveSuccessCliResult() {
  return retrieveFilesResult(successRetrieveFiles());
}

function retrieveSuccessForComponents(components) {
  return retrieveFilesResult(components.map((component) => ({ path: pathForComponent(component), state: 'Changed' })));
}

function successRetrieveFiles() {
  return [
    { path: 'force-app/main/default/classes/GiftAutomation.cls', state: 'Changed' },
    { path: 'force-app/main/default/triggers/GiftTransactionTrigger.trigger', state: 'Changed' },
    { path: 'force-app/main/default/objects/GiftTransaction/fields/GiftCommitmentId.field-meta.xml', state: 'Changed' },
    { path: 'force-app/main/default/objects/GiftTransaction/fields/Status.field-meta.xml', state: 'Changed' },
    { path: 'force-app/main/default/objects/GiftCommitment/GiftCommitment.object-meta.xml', state: 'Changed' },
    { path: 'force-app/main/default/objects/GiftTransaction/GiftTransaction.object-meta.xml', state: 'Changed' },
    { path: 'force-app/main/default/flows/GiftTransaction_Numbering.flow-meta.xml', state: 'Changed' },
    { path: 'force-app/main/default/layouts/GiftTransaction-Gift Transaction Layout.layout-meta.xml', state: 'Changed' },
    { path: 'force-app/main/default/permissionsets/Gift_Operations.permissionset-meta.xml', state: 'Changed' },
    { path: 'force-app/main/default/objects/GiftTransaction/validationRules/Require_Status.validationRule-meta.xml', state: 'Changed' }
  ];
}

function pathForComponent(component) {
  if (component.type === 'ApexClass') return `force-app/main/default/classes/${component.apiName}.cls`;
  if (component.type === 'ApexTrigger') return `force-app/main/default/triggers/${component.apiName}.trigger`;
  if (component.type === 'CustomField') {
    const [objectApiName, fieldApiName] = component.apiName.split('.');
    return `force-app/main/default/objects/${objectApiName}/fields/${fieldApiName}.field-meta.xml`;
  }
  if (component.type === 'CustomObject') return `force-app/main/default/objects/${component.apiName}/${component.apiName}.object-meta.xml`;
  if (component.type === 'Flow') return `force-app/main/default/flows/${component.apiName}.flow-meta.xml`;
  if (component.type === 'Layout') return `force-app/main/default/layouts/${component.apiName}.layout-meta.xml`;
  if (component.type === 'PermissionSet') return `force-app/main/default/permissionsets/${component.apiName}.permissionset-meta.xml`;
  if (component.type === 'ValidationRule') {
    const [objectApiName, ruleApiName] = component.apiName.split('.');
    return `force-app/main/default/objects/${objectApiName}/validationRules/${ruleApiName}.validationRule-meta.xml`;
  }
  throw new Error(`No retrieve fixture path for ${component.type}:${component.apiName}`);
}

function componentClaimForPath(path) {
  const matches = [
    [/\/classes\/([^/]+)\.cls$/, 'ApexClass', (match) => match[1]],
    [/\/triggers\/([^/]+)\.trigger$/, 'ApexTrigger', (match) => match[1]],
    [/\/objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/, 'CustomField', (match) => `${match[1]}.${match[2]}`],
    [/\/objects\/([^/]+)\/\1\.object-meta\.xml$/, 'CustomObject', (match) => match[1]],
    [/\/flows\/([^/]+)\.flow-meta\.xml$/, 'Flow', (match) => match[1]],
    [/\/layouts\/([^/]+)\.layout-meta\.xml$/, 'Layout', (match) => match[1]],
    [/\/permissionsets\/([^/]+)\.permissionset-meta\.xml$/, 'PermissionSet', (match) => match[1]],
    [/\/objects\/([^/]+)\/validationRules\/([^/]+)\.validationRule-meta\.xml$/, 'ValidationRule', (match) => `${match[1]}.${match[2]}`]
  ];
  for (const [pattern, type, apiName] of matches) {
    const match = String(path).match(pattern);
    if (match) return { type, apiName: apiName(match) };
  }
  throw new Error(`No component claim fixture for ${path}`);
}

function retrieveFilesResult(files, resultOverrides = {}) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      status: 0,
      result: {
        done: true,
        status: 'Succeeded',
        files,
        ...resultOverrides
      }
    }),
    stderr: ''
  };
}

function retrieveCompatibilityFileResponsesResult() {
  const parsed = JSON.parse(retrieveSuccessCliResult().stdout);
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      status: 0,
      result: {
        done: true,
        status: 'Succeeded',
        fileResponses: parsed.result.files.map((file) => ({ filePath: file.path, state: file.state }))
      }
    }),
    stderr: ''
  };
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
