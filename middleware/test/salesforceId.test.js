import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSalesforceId, requireSalesforceOrgId } from '../src/utils/salesforceId.js';

test('canonical Salesforce IDs match valid 15-character and 18-character equivalents', () => {
  assert.equal(canonicalSalesforceId('00Dg500000E07e9'), '00Dg500000E07e9EAB');
  assert.equal(canonicalSalesforceId('00Dg500000E07e9EAB'), '00Dg500000E07e9EAB');
  assert.equal(requireSalesforceOrgId('00Dg500000E07e9'), '00Dg500000E07e9EAB');
});

test('Salesforce ID validation rejects corrupt checksum suffixes', () => {
  assert.throws(() => canonicalSalesforceId('00Dg500000E07e9EAC'), /checksum|Salesforce ID/);
  assert.throws(() => requireSalesforceOrgId('00Dg500000E07e9EAC'), /checksum|Salesforce ID/);
});

test('Salesforce ID validation rejects malformed lengths and non-alphanumeric input', () => {
  for (const value of ['00Dg500000E07e', '00Dg500000E07e9EXTRA', '00Dg500000E07e!', ' 00Dg500000E07e9 ']) {
    assert.throws(() => canonicalSalesforceId(value), /valid Salesforce ID/);
  }
});

test('case-different 15-character Salesforce IDs do not silently collapse', () => {
  assert.equal(canonicalSalesforceId('00Dg500000E07e9'), '00Dg500000E07e9EAB');
  assert.equal(canonicalSalesforceId('00DG500000E07E9'), '00DG500000E07E9MAJ');
  assert.notEqual(canonicalSalesforceId('00Dg500000E07e9'), canonicalSalesforceId('00DG500000E07E9'));
});

test('Salesforce org IDs must use the Organization key prefix', () => {
  assert.throws(() => requireSalesforceOrgId('005g5000009ImIk'), /Salesforce org ID/);
});
