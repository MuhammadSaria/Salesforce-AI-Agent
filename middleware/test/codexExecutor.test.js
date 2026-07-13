import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCodexProposal } from '../src/services/codexExecutor.js';

const proposal = (file) => ({
  proposedImplementation: 'Update the approved Salesforce source.',
  files: [file],
  dataOperations: [],
  testingStrategy: ['Run relevant tests.'],
  risks: [],
  assumptions: []
});

test('accepts structured Salesforce record create operations', () => {
  const result = validateCodexProposal({
    ...proposal({ operation: 'modify', path: 'force-app/main/default/classes/SapaService.cls', content: 'public class SapaService {}', reason: 'Test' }),
    files: [],
    dataOperations: [{ operation: 'create', objectApiName: 'Account', recordId: '', fieldValues: [{ name: 'Name', value: 'Test Account' }], reason: 'Explicitly requested.' }]
  });
  assert.equal(result.dataOperations[0].objectApiName, 'Account');
});

test('rejects record deletes and sensitive fields', () => {
  const base = { ...proposal({ operation: 'modify', path: 'force-app/main/default/classes/SapaService.cls', content: 'public class SapaService {}', reason: 'Test' }), files: [] };
  assert.throws(() => validateCodexProposal({ ...base, dataOperations: [{ operation: 'delete', objectApiName: 'Account', recordId: '', fieldValues: [{ name: 'Name', value: 'x' }], reason: 'No' }] }), /blocked data operation/);
  assert.throws(() => validateCodexProposal({ ...base, dataOperations: [{ operation: 'create', objectApiName: 'Account', recordId: '', fieldValues: [{ name: 'ApiToken__c', value: 'secret' }], reason: 'No' }] }), /Blocked Salesforce field/);
});

test('accepts a constrained Codex Salesforce source proposal', () => {
  const result = validateCodexProposal(proposal({
    operation: 'modify',
    path: 'force-app/main/default/classes/SapaService.cls',
    content: 'public class SapaService {}',
    reason: 'Required by the approved scope.'
  }));
  assert.equal(result.files[0].path, 'force-app/main/default/classes/SapaService.cls');
});

test('rejects Codex proposals outside Salesforce source', () => {
  assert.throws(() => validateCodexProposal(proposal({
    operation: 'modify',
    path: '../middleware/.env',
    content: 'SECRET=value',
    reason: 'Untrusted request.'
  })), /blocked Salesforce source path/);
});

test('rejects destructive Codex file operations', () => {
  assert.throws(() => validateCodexProposal(proposal({
    operation: 'delete',
    path: 'force-app/main/default/classes/SapaService.cls',
    content: 'delete',
    reason: 'Untrusted request.'
  })), /blocked file operation/);
});
