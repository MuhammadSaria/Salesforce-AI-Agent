import test from 'node:test';
import assert from 'node:assert/strict';
import { generateObjectFieldSource } from '../src/specialists/objectFieldSpecialist.js';
import { generateSecuritySource } from '../src/specialists/securitySpecialist.js';
import { generateFlowSource } from '../src/specialists/flowSpecialist.js';
import { runSpecialists } from '../src/services/specialistRunner.js';

const FIELD_API = 'GiftTransaction.Installment_Number__c';
const PERMISSION_API = 'Gift_Operations';
const FLOW_API = 'Assign_Installment';

test('generates one complete approved Number CustomField document', async () => {
  const { result, calls } = await generate('OBJECT_FIELD', objectFieldResult());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].specialistId, 'OBJECT_FIELD');
  assert.equal(calls[0].requirement, 'Number completed recurring-donation transactions.');
  assert.equal('jobId' in calls[0], false);
  assert.equal('workspace' in calls[0], false);
  assert.equal('orgContext' in calls[0], false);
  assert.equal(calls[0].inspectionEvidence[0].kind, 'RELATIONSHIP');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].apiName, FIELD_API);
  assert.match(result.operations[0].content, /^<\?xml[\s\S]*<CustomField xmlns="http:\/\/soap\.sforce\.com\/2006\/04\/metadata">/);
  assert.match(result.operations[0].content, /<type>Number<\/type>/);
  assert.match(result.operations[0].content, /<\/CustomField>\s*$/);
});

test('generates least-privilege permission metadata using only the field dependency', async () => {
  const request = specialistRequest('SECURITY_PERMISSIONS', [dependency('OBJECT_FIELD', objectFieldResult())]);
  const calls = [];
  const result = await generateSecuritySource(request, { modelRunner: runner(permissionResult(), calls) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].dependencyResults.map((item) => item.specialistId), ['OBJECT_FIELD']);
  assert.equal(result.operations[0].apiName, PERMISSION_API);
  assert.match(result.operations[0].content, /^<\?xml[\s\S]*<PermissionSet xmlns="http:\/\/soap\.sforce\.com\/2006\/04\/metadata">/);
  assert.match(result.operations[0].content, new RegExp(`<field>${FIELD_API}<\\/field>[\\s\\S]*<readable>true<\\/readable>[\\s\\S]*<editable>true<\\/editable>`));
  assert.doesNotMatch(result.operations[0].content, /<objectPermissions>|<userPermissions>|<classAccesses>|Other__c/);
});

test('generates a complete Draft Flow with the approved recurring-donation semantics', async () => {
  const calls = [];
  const result = await generateFlowSource(flowRequest(), { modelRunner: runner(flowResult(), calls) });
  const xml = result.operations[0].content;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].dependencyResults.map((item) => item.specialistId), ['OBJECT_FIELD', 'SECURITY_PERMISSIONS']);
  assert.match(xml, /^<\?xml[\s\S]*<Flow xmlns="http:\/\/soap\.sforce\.com\/2006\/04\/metadata">/);
  assert.match(xml, /<status>Draft<\/status>/);
  assert.doesNotMatch(xml, /<status>Active<\/status>/);
  for (const marker of [
    'CREATE_AS_COMPLETED', 'TRANSITION_TO_COMPLETED', 'ALREADY_NUMBERED_PROTECTION',
    'SAME_PARENT_LOOKUP', 'FIRST_INSTALLMENT_ONE', 'INCREMENT_N_PLUS_ONE',
    'REVERSAL_RETENTION', 'NO_HISTORICAL_RENUMBER', 'NO_OVERWRITE'
  ]) assert.match(xml, new RegExp(`<description>${marker}<\\/description>`), marker);
  assert.match(xml, /<\/Flow>\s*$/);
  assert.ok(result.risks.some((risk) => /concurr/i.test(risk) && /cannot guarantee strict uniqueness/i.test(risk)));
});

test('rejects a structurally plausible Flow that omits executable completed and non-overwrite criteria', async () => {
  const incomplete = flowResult();
  incomplete.operations[0].content = incomplete.operations[0].content
    .replace(/<filters><field>Status[\s\S]*?<\/filters>/, '')
    .replace(/<filters><field>Installment_Number__c[\s\S]*?<\/filters>/, '');
  await assert.rejects(
    () => generateFlowSource(flowRequest(), { modelRunner: runner(incomplete) }),
    (error) => error.code === 'SPECIALIST_FLOW_INVALID' && /status|non-overwrite/i.test(error.message)
  );
});

test('rejects Active Flow output instead of rewriting it', async () => {
  const active = flowResult();
  active.operations[0].content = active.operations[0].content.replace('<status>Draft</status>', '<status>Active</status>');
  await assert.rejects(
    () => generateFlowSource(flowRequest(), { modelRunner: runner(active) }),
    (error) => error.code === 'FLOW_MUST_BE_INACTIVE'
  );
});

test('strict concurrent uniqueness returns BLOCKED with a material Apex scope question and no operations', async () => {
  const request = flowRequest({
    planContext: {
      ...flowRequest().planContext,
      acceptanceCriteria: ['Strict uniqueness must be guaranteed during concurrent processing.']
    }
  });
  let calls = 0;
  const result = await generateFlowSource(request, { modelRunner: async () => { calls += 1; return flowResult(); } });
  assert.equal(calls, 0);
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.operations, []);
  assert.match(result.materialQuestion, /locking-capable Apex/i);
  assert.equal(JSON.stringify(result).includes('ApexClass'), false);
});

test('common concurrent uniqueness wording also returns BLOCKED', async () => {
  const request = flowRequest({
    planContext: { ...flowRequest().planContext, acceptanceCriteria: ['Installment numbers must be unique under concurrent processing.'] }
  });
  const result = await generateFlowSource(request, { modelRunner: runner(flowResult()) });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.operations, []);
});

test('strict concurrency remains deterministically BLOCKED when the model is unavailable', async () => {
  const request = flowRequest({
    planContext: { ...flowRequest().planContext, acceptanceCriteria: ['Installment numbers must be unique under concurrent processing.'] }
  });
  const result = await generateFlowSource(request, { modelRunner: async () => { throw new Error('model unavailable'); } });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.operations, []);
});

test('model input includes bounded relevant retrieved source and rejects oversized aggregate context', async () => {
  const request = specialistRequest('OBJECT_FIELD');
  request.inspectionEvidence.push({ evidenceId: 'field-source', kind: 'RETRIEVED_COMPONENT', componentType: 'CustomField', componentApiName: FIELD_API, retrievedSource: '<CustomField>existing</CustomField>', sourceOrgId: '00D000000000001AAA', active: true, stale: false, observedAt: new Date().toISOString() });
  const calls = [];
  await generateObjectFieldSource(request, { modelRunner: runner(objectFieldResult(), calls) });
  assert.equal(calls[0].inspectionEvidence.find((item) => item.kind === 'RETRIEVED_COMPONENT').retrievedSource, '<CustomField>existing</CustomField>');

  const oversized = flowRequest();
  oversized.dependencyResults = Array.from({ length: 3 }, (_, index) => ({
    specialistId: index === 2 ? 'SECURITY_PERMISSIONS' : 'OBJECT_FIELD',
    status: 'COMPLETED',
    operations: [{ ...objectFieldResult().operations[0], content: 'x'.repeat(400000) }],
    risks: [], verification: []
  }));
  await assert.rejects(
    () => generateFlowSource(oversized, { modelRunner: runner(flowResult()) }),
    (error) => error.code === 'SPECIALIST_MODEL_INPUT_TOO_LARGE'
  );
});

test('rejects incomplete metadata source for every specialist', async () => {
  for (const [generateSource, request, result] of [
    [generateObjectFieldSource, specialistRequest('OBJECT_FIELD'), objectFieldResult()],
    [generateSecuritySource, specialistRequest('SECURITY_PERMISSIONS', [dependency('OBJECT_FIELD', objectFieldResult())]), permissionResult()],
    [generateFlowSource, flowRequest(), flowResult()]
  ]) {
    for (const content of ['', 'TODO', '```xml\n<Flow/>\n```', '<Flow><status>Draft</status></Flow>', 'rest omitted']) {
      const incomplete = structuredClone(result);
      incomplete.operations[0].content = content;
      await assert.rejects(() => generateSource(request, { modelRunner: runner(incomplete) }), (error) => ['SPECIALIST_SOURCE_INCOMPLETE', 'SPECIALIST_XML_INVALID'].includes(error.code));
    }
  }
});

test('Task 7 rejects cross-owner and unapproved operations returned by real specialist path', async () => {
  const crossOwner = flowResult();
  crossOwner.operations[0] = permissionResult().operations[0];
  await assert.rejects(
    () => runSpecialists(runInput(), { runners: productionLikeRunners({ FLOW: crossOwner }) }),
    (error) => error.code === 'SPECIALIST_OWNERSHIP_VIOLATION'
  );
  const unapproved = flowResult();
  unapproved.operations[0] = { ...unapproved.operations[0], apiName: 'Unapproved_Flow', path: 'force-app/main/default/flows/Unapproved_Flow.flow-meta.xml' };
  await assert.rejects(
    () => runSpecialists(runInput(), { runners: productionLikeRunners({ FLOW: unapproved }) }),
    (error) => error.code === 'SPECIALIST_SCOPE_VIOLATION'
  );
});

test('bounded pipeline persists results without source writes, Salesforce validation, or deployment', async () => {
  const updates = [];
  const jobStore = { async update(jobId, patch) { updates.push({ jobId, patch }); } };
  const result = await runSpecialists(runInput(), { runners: productionLikeRunners(), jobStore });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(updates.length, 3);
  assert.deepEqual(Object.keys(updates.at(-1).patch.specialistResults), ['OBJECT_FIELD', 'SECURITY_PERMISSIONS', 'FLOW']);
  assert.equal(JSON.stringify(updates).includes('validation'), false);
  assert.equal(JSON.stringify(updates).includes('deployment'), false);
  assert.equal(JSON.stringify(updates).includes('command'), false);
});

async function generate(specialistId, output) {
  const calls = [];
  const result = await generateObjectFieldSource(specialistRequest(specialistId), { modelRunner: runner(output, calls) });
  return { result, calls };
}

function runner(output, calls = []) {
  return async (input) => { calls.push(input); return structuredClone(output); };
}

function productionLikeRunners(overrides = {}) {
  return {
    OBJECT_FIELD: (request) => generateObjectFieldSource(request, { modelRunner: runner(overrides.OBJECT_FIELD || objectFieldResult()) }),
    SECURITY_PERMISSIONS: (request) => generateSecuritySource(request, { modelRunner: runner(overrides.SECURITY_PERMISSIONS || permissionResult()) }),
    FLOW: (request) => generateFlowSource(request, { modelRunner: runner(overrides.FLOW || flowResult()) })
  };
}

function specialistRequest(specialistId, dependencyResults = []) {
  const components = {
    OBJECT_FIELD: { operation: 'create', metadataType: 'CustomField', apiName: FIELD_API, owner: 'OBJECT_FIELD', reason: 'Store installment sequence.' },
    SECURITY_PERMISSIONS: { operation: 'modify', metadataType: 'PermissionSet', apiName: PERMISSION_API, owner: 'SECURITY_PERMISSIONS', reason: 'Grant exact field access.' },
    FLOW: { operation: 'modify', metadataType: 'Flow', apiName: FLOW_API, owner: 'FLOW', reason: 'Assign installment sequence.' }
  };
  return {
    specialistId,
    jobId: 'task-8-job',
    planVersion: 1,
    sourceOrgId: '00D000000000001AAA',
    workspace: { workspacePath: 'implementation/plan-v1/project', planVersion: 1 },
    approvedComponents: [components[specialistId]],
    planContext: {
      requirement: 'Number completed recurring-donation transactions.',
      acceptanceCriteria: ['Sequential best-effort numbering is acceptable.'],
      expectedBehavior: ['Create and transitioned completed records are numbered once for the same recurring parent.'],
      risks: ['Highest plus one cannot guarantee strict uniqueness under concurrency.']
    },
    inspectionEvidence: [
      { evidenceId: 'relationship', kind: 'RELATIONSHIP', sourceOrgId: '00D000000000001AAA', objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', targetObjectApiName: 'GiftCommitment', componentType: 'CustomField', componentApiName: 'GiftTransaction.GiftCommitmentId', active: true, stale: false, observedAt: new Date().toISOString() },
      { evidenceId: 'status-completed', kind: 'STATUS_VALUE', sourceOrgId: '00D000000000001AAA', objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Completed', componentType: 'CustomField', componentApiName: 'GiftTransaction.Status', active: true, stale: false, observedAt: new Date().toISOString() }
    ],
    dependencyResults
  };
}

function flowRequest(overrides = {}) {
  return { ...specialistRequest('FLOW', [dependency('OBJECT_FIELD', objectFieldResult()), dependency('SECURITY_PERMISSIONS', permissionResult())]), ...overrides };
}

function dependency(specialistId, result) {
  return { specialistId, status: result.status, operations: result.operations, risks: result.risks, verification: result.verification };
}

function objectFieldResult() {
  return completed({
    operation: 'create',
    path: 'force-app/main/default/objects/GiftTransaction/fields/Installment_Number__c.field-meta.xml',
    content: '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Installment_Number__c</fullName><label>Installment Number</label><precision>18</precision><scale>0</scale><type>Number</type></CustomField>',
    metadataType: 'CustomField', apiName: FIELD_API, reason: 'Store installment sequence.'
  });
}

function permissionResult() {
  return completed({
    operation: 'modify',
    path: 'force-app/main/default/permissionsets/Gift_Operations.permissionset-meta.xml',
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><fieldPermissions><field>${FIELD_API}</field><readable>true</readable><editable>true</editable></fieldPermissions></PermissionSet>`,
    metadataType: 'PermissionSet', apiName: PERMISSION_API, reason: 'Grant exact field access.'
  });
}

function flowResult() {
  const descriptions = [
    'CREATE_AS_COMPLETED', 'TRANSITION_TO_COMPLETED', 'ALREADY_NUMBERED_PROTECTION',
    'SAME_PARENT_LOOKUP', 'FIRST_INSTALLMENT_ONE', 'INCREMENT_N_PLUS_ONE',
    'REVERSAL_RETENTION', 'NO_HISTORICAL_RENUMBER', 'NO_OVERWRITE'
  ].map((value) => `<description>${value}</description>`).join('');
  return completed({
    operation: 'modify',
    path: 'force-app/main/default/flows/Assign_Installment.flow-meta.xml',
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>65.0</apiVersion>${descriptions}<formulas><name>Next_Installment_Number</name><dataType>Number</dataType><expression>{!Highest_Same_Parent.Installment_Number__c} + 1</expression><scale>0</scale></formulas><recordLookups><name>Highest_Same_Parent</name><connector><targetReference>Has_Previous_Number</targetReference></connector><filters><field>GiftCommitmentId</field><operator>EqualTo</operator><value><elementReference>$Record.GiftCommitmentId</elementReference></value></filters><filters><field>Installment_Number__c</field><operator>IsNull</operator><value><booleanValue>false</booleanValue></value></filters><object>GiftTransaction</object><sortField>Installment_Number__c</sortField><sortOrder>Desc</sortOrder><getFirstRecordOnly>true</getFirstRecordOnly></recordLookups><decisions><name>Has_Previous_Number</name><defaultConnector><targetReference>Assign_First</targetReference></defaultConnector><rules><name>Increment_Previous</name><conditionLogic>and</conditionLogic><conditions><leftValueReference>Highest_Same_Parent.Id</leftValueReference><operator>IsNull</operator><rightValue><booleanValue>false</booleanValue></rightValue></conditions><connector><targetReference>Assign_Increment</targetReference></connector></rules></decisions><assignments><name>Assign_First</name><assignmentItems><assignToReference>$Record.Installment_Number__c</assignToReference><operator>Assign</operator><value><numberValue>1</numberValue></value></assignmentItems></assignments><assignments><name>Assign_Increment</name><assignmentItems><assignToReference>$Record.Installment_Number__c</assignToReference><operator>Assign</operator><value><elementReference>Next_Installment_Number</elementReference></value></assignmentItems></assignments><start><connector><targetReference>Highest_Same_Parent</targetReference></connector><filterLogic>and</filterLogic><filters><field>Status</field><operator>EqualTo</operator><value><stringValue>Completed</stringValue></value></filters><filters><field>Installment_Number__c</field><operator>IsNull</operator><value><booleanValue>true</booleanValue></value></filters><object>GiftTransaction</object><recordTriggerType>CreateAndUpdate</recordTriggerType><triggerType>RecordBeforeSave</triggerType><doesRequireRecordChangedToMeetCriteria>true</doesRequireRecordChangedToMeetCriteria></start><status>Draft</status></Flow>`,
    metadataType: 'Flow', apiName: FLOW_API, reason: 'Assign installment sequence.'
  }, ['Highest plus one cannot guarantee strict uniqueness under concurrent processing.']);
}

function completed(operation, risks = []) {
  return { status: 'COMPLETED', operations: [operation], dependencies: [], risks, verification: ['Complete source generated in memory.'] };
}

function runInput() {
  return {
    job: { jobId: 'task-8-job' },
    workspace: { workspacePath: 'implementation/plan-v1/project', planVersion: 1 },
    inspection: { evidence: [
      { evidenceId: 'relationship', kind: 'RELATIONSHIP', sourceOrgId: '00D000000000001AAA', objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', targetObjectApiName: 'GiftCommitment', componentType: 'CustomField', componentApiName: 'GiftTransaction.GiftCommitmentId', active: true, stale: false, observedAt: new Date().toISOString() },
      { evidenceId: 'status-completed', kind: 'STATUS_VALUE', sourceOrgId: '00D000000000001AAA', objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Completed', componentType: 'CustomField', componentApiName: 'GiftTransaction.Status', active: true, stale: false, observedAt: new Date().toISOString() }
    ] },
    plan: {
      requirement: 'Number completed recurring-donation transactions.', planVersion: 1,
      acceptanceCriteria: ['Sequential best-effort numbering is acceptable.'],
      expectedBehavior: ['Number once.'], risks: ['Concurrency limitation.'], evidenceIds: ['relationship', 'status-completed'],
      components: [
        { operation: 'create', metadataType: 'CustomField', apiName: FIELD_API, owner: 'object-field-specialist', reason: 'Store installment sequence.' },
        { operation: 'modify', metadataType: 'PermissionSet', apiName: PERMISSION_API, owner: 'security-specialist', reason: 'Grant exact field access.' },
        { operation: 'modify', metadataType: 'Flow', apiName: FLOW_API, owner: 'flow-specialist', reason: 'Assign installment sequence.' }
      ]
    }
  };
}
