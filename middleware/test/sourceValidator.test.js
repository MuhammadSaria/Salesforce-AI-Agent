import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpecialistOperations } from '../src/validation/sourceValidator.js';
import { connectedFlowXml } from './fixtures/connectedFlow.js';

const ORG = '00Dg500000E07e9EAB';
const FIELD_PATH = 'force-app/main/default/objects/GiftTransaction/fields/Installment_Number__c.field-meta.xml';
const PERMISSION_PATH = 'force-app/main/default/permissionsets/Gift_Operations.permissionset-meta.xml';
const FLOW_PATH = 'force-app/main/default/flows/Assign_Installment.flow-meta.xml';

test('accepts the complete approved Task 8 operation set and returns one deterministic write-eligibility hash', () => {
  const validated = validateSpecialistOperations(validInput());
  assert.equal(validated.operations.length, 3);
  assert.deepEqual(validated.operations.map((operation) => operation.path), [FIELD_PATH, FLOW_PATH, PERMISSION_PATH]);
  assert.match(validated.sourceHash, /^[a-f0-9]{64}$/);
});

test('rejects a cross-owner operation at the authoritative complete-set gate', () => {
  const input = validInput();
  input.ownership[FLOW_PATH] = 'SECURITY_PERMISSIONS';
  assert.throws(() => validateSpecialistOperations(input), (error) => error.code === 'SPECIALIST_OWNERSHIP_VIOLATION');
});

test('rejects an otherwise canonical unapproved component at the authoritative complete-set gate', () => {
  const input = validInput();
  input.operations[2] = { ...input.operations[2], apiName: 'Unapproved_Flow', path: 'force-app/main/default/flows/Unapproved_Flow.flow-meta.xml' };
  delete input.ownership[FLOW_PATH];
  input.ownership[input.operations[2].path] = 'FLOW';
  assert.throws(() => validateSpecialistOperations(input), (error) => error.code === 'SPECIALIST_SCOPE_VIOLATION');
});

test('one invalid operation rejects the complete set without returning a partially validated subset', () => {
  const input = validInput();
  input.operations[1].content = input.operations[1].content.replace('</PermissionSet>', '<description>Authorization: Bearer abcdefghijklmnopqrstuvwxyz</description></PermissionSet>');
  assert.throws(() => validateSpecialistOperations(input), (error) => error.code === 'SPECIALIST_SECRET_DETECTED' && !/Bearer|abcdef/i.test(error.message));
});

test('rejects obvious shell or child-process payloads without executing source', () => {
  const input = validInput();
  input.operations[0].content = input.operations[0].content.replace('</CustomField>', '<description>node:child_process exec("cmd.exe")</description></CustomField>');
  assert.throws(() => validateSpecialistOperations(input), (error) => error.code === 'SPECIALIST_SCRIPT_DETECTED');
});

test('rejects a source document above the byte limit before parsing', () => {
  const input = validInput();
  input.operations[0].content = `<?xml version="1.0"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><description>${'x'.repeat(500000)}</description></CustomField>`;
  assert.throws(() => validateSpecialistOperations(input), (error) => error.code === 'SPECIALIST_SOURCE_TOO_LARGE');
});

test('rejects the complete operation set above the aggregate byte limit', () => {
  const input = validInput();
  input.operations = Array.from({ length: 11 }, (_, index) => {
    const apiName = `GiftTransaction.Installment_${index}__c`;
    const path = `force-app/main/default/objects/GiftTransaction/fields/Installment_${index}__c.field-meta.xml`;
    const component = { operation: 'create', metadataType: 'CustomField', apiName, owner: 'object-field-specialist', reason: 'Store bounded sequence data.' };
    input.plan.components[index] = component;
    input.ownership[path] = 'OBJECT_FIELD';
    return {
      operation: component.operation,
      metadataType: component.metadataType,
      apiName: component.apiName,
      reason: component.reason,
      path,
      content: `<?xml version="1.0"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Installment_${index}__c</fullName><description>${'x'.repeat(475000)}</description><type>Number</type></CustomField>`
    };
  });
  input.plan.components.length = 11;
  input.ownership = Object.fromEntries(input.operations.map((operation) => [operation.path, 'OBJECT_FIELD']));

  assert.throws(() => validateSpecialistOperations(input), (error) => error.code === 'SPECIALIST_SOURCE_TOO_LARGE');
});

test('rejects invalid Number precision and scale instead of rewriting CustomField source', () => {
  const input = validInput();
  input.operations[0].content = input.operations[0].content.replace('<precision>18</precision>', '<precision>19</precision>').replace('<scale>0</scale>', '<scale>20</scale>');
  assert.throws(() => validateSpecialistOperations(input), (error) => error.code === 'SPECIALIST_SOURCE_INCOMPLETE');
});

test('rejects valid PermissionSet XML that expands beyond approved field access', () => {
  const input = validInput();
  input.operations[1].content = input.operations[1].content.replace('</PermissionSet>', '<userPermissions><enabled>true</enabled><name>ModifyAllData</name></userPermissions></PermissionSet>');
  assert.throws(() => validateSpecialistOperations(input), (error) => error.code === 'SPECIALIST_SCOPE_VIOLATION');
});

test('rejects permission expansion hidden below a non-permission wrapper element', () => {
  const input = validInput();
  input.operations[1].content = input.operations[1].content.replace('</PermissionSet>', '<description><userPermissions><enabled>true</enabled><name>ModifyAllData</name></userPermissions></description></PermissionSet>');
  assert.throws(() => validateSpecialistOperations(input), (error) => error.code === 'SPECIALIST_SCOPE_VIOLATION');
});

test('uses only plan-approved evidence relevant to the Flow specialist', () => {
  const input = validInput();
  input.plan.evidenceIds.push('field-source');
  input.inspection.evidence.push({
    evidenceId: 'field-source', kind: 'RETRIEVED_COMPONENT', sourceOrgId: ORG,
    componentType: 'CustomField', componentApiName: 'GiftTransaction.Installment_Number__c',
    retrievedSource: '<?xml version="1.0"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"></CustomField>',
    active: true, stale: false, observedAt: new Date().toISOString()
  });
  assert.doesNotThrow(() => validateSpecialistOperations(input));
});

export function validInput() {
  const operations = [fieldOperation(), permissionOperation(), flowOperation()];
  return {
    operations,
    plan: approvedPlan(),
    ownership: { [FIELD_PATH]: 'OBJECT_FIELD', [PERMISSION_PATH]: 'SECURITY_PERMISSIONS', [FLOW_PATH]: 'FLOW' },
    inspection: trustedInspection()
  };
}

function approvedPlan() {
  return {
    components: [
      { operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', owner: 'object-field-specialist', reason: 'Store installment sequence.' },
      { operation: 'modify', metadataType: 'PermissionSet', apiName: 'Gift_Operations', owner: 'security-specialist', reason: 'Grant exact field access.' },
      { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Assign installment sequence.' }
    ],
    evidenceIds: ['relationship', 'status-completed'],
    trustedBinding: { inspectionHash: 'inspection-hash', sourceOrgId: ORG },
    planHash: 'plan-hash', scopeHash: 'scope-hash', planVersion: 1
  };
}

function trustedInspection() {
  return {
    hash: 'inspection-hash', sourceOrgId: ORG,
    evidence: [
      { evidenceId: 'relationship', kind: 'RELATIONSHIP', sourceOrgId: ORG, objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', targetObjectApiName: 'GiftCommitment', componentType: 'CustomField', componentApiName: 'GiftTransaction.GiftCommitmentId', active: true, stale: false, observedAt: new Date().toISOString() },
      { evidenceId: 'status-completed', kind: 'STATUS_VALUE', sourceOrgId: ORG, objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Completed', componentType: 'CustomField', componentApiName: 'GiftTransaction.Status', active: true, stale: false, observedAt: new Date().toISOString() }
    ]
  };
}

function fieldOperation() {
  return { operation: 'create', path: FIELD_PATH, metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', reason: 'Store installment sequence.', content: '<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Installment_Number__c</fullName><label>Installment Number</label><precision>18</precision><scale>0</scale><type>Number</type></CustomField>' };
}

function permissionOperation() {
  return { operation: 'modify', path: PERMISSION_PATH, metadataType: 'PermissionSet', apiName: 'Gift_Operations', reason: 'Grant exact field access.', content: '<?xml version="1.0" encoding="UTF-8"?><PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><fieldPermissions><field>GiftTransaction.Installment_Number__c</field><readable>true</readable><editable>true</editable></fieldPermissions></PermissionSet>' };
}

function flowOperation() {
  return { operation: 'modify', path: FLOW_PATH, metadataType: 'Flow', apiName: 'Assign_Installment', reason: 'Assign installment sequence.', content: completeFlowXml() };
}

function completeFlowXml() {
  return connectedFlowXml().replace('</apiVersion>', '</apiVersion><label>Assign Installment</label><processType>AutoLaunchedFlow</processType>');
}
