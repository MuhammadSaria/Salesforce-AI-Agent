import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMetadataPath, assertCanonicalOperationPath } from '../src/domain/metadataPath.js';

const cases = [
  'force-app/main/default/flows/../../permissionsets/Escalation.permissionset-meta.xml',
  'force-app/main/default/flows/../../classes/X.cls',
  'force-app\\main\\default\\flows\\..\\..\\classes\\X.cls',
  'force-app/main/default/flows/%2e%2e/%2e%2e/classes/X.cls',
  '/force-app/main/default/flows/Assign_Installment.flow-meta.xml',
  'C:/force-app/main/default/flows/Assign_Installment.flow-meta.xml',
  '\\\\server\\share\\force-app\\main\\default\\flows\\Assign_Installment.flow-meta.xml',
  'force-app/main/default//flows/Assign_Installment.flow-meta.xml',
  'force-app/main/default/flows/Other.flow-meta.xml',
  'https://example.test/force-app/main/default/flows/Assign_Installment.flow-meta.xml'
];

for (const path of cases) {
  test(`rejects untrusted metadata path ${JSON.stringify(path)}`, () => {
    assert.throws(
      () => assertCanonicalOperationPath({ operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', path }),
      (error) => error.code === 'SPECIALIST_PATH_VIOLATION'
    );
  });
}

test('derives exact canonical Task 8 paths from trusted component identity', () => {
  assert.equal(canonicalMetadataPath('CustomField', 'GiftTransaction.Installment_Number__c'), 'force-app/main/default/objects/GiftTransaction/fields/Installment_Number__c.field-meta.xml');
  assert.equal(canonicalMetadataPath('PermissionSet', 'Gift_Operations'), 'force-app/main/default/permissionsets/Gift_Operations.permissionset-meta.xml');
  assert.equal(canonicalMetadataPath('Flow', 'Assign_Installment'), 'force-app/main/default/flows/Assign_Installment.flow-meta.xml');
  assert.doesNotThrow(() => assertCanonicalOperationPath({ operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', path: 'force-app/main/default/flows/Assign_Installment.flow-meta.xml' }));
});

test('rejects field object/name and permission filename mismatches', () => {
  assert.throws(() => assertCanonicalOperationPath({ operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', path: 'force-app/main/default/objects/Other/fields/Installment_Number__c.field-meta.xml' }), (error) => error.code === 'SPECIALIST_PATH_VIOLATION');
  assert.throws(() => assertCanonicalOperationPath({ operation: 'modify', metadataType: 'PermissionSet', apiName: 'Gift_Operations', path: 'force-app/main/default/permissionsets/Admin.permissionset-meta.xml' }), (error) => error.code === 'SPECIALIST_PATH_VIOLATION');
});
