import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexArgs, codexPlanningFailure, validateCodexProposal } from '../src/services/codexExecutor.js';

const proposal = (file) => ({
  proposedImplementation: 'Update the approved Salesforce source.',
  implementationSteps: ['Prepare the requested Salesforce behavior.', 'Validate that the behavior works as requested.'],
  expectedOutcome: 'Users can complete the requested process.',
  businessImpact: 'Only the approved process changes.',
  outOfScope: ['Unrelated Salesforce features.'],
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

test('accepts an exact record delete and rejects unsafe data operations', () => {
  const base = { ...proposal({ operation: 'modify', path: 'force-app/main/default/classes/SapaService.cls', content: 'public class SapaService {}', reason: 'Test' }), files: [] };
  const result = validateCodexProposal({ ...base, dataOperations: [{ operation: 'delete', objectApiName: 'Account', recordId: '001000000000001AAA', fieldValues: [], reason: 'Explicitly requested.' }] });
  assert.equal(result.dataOperations[0].operation, 'delete');
  assert.throws(() => validateCodexProposal({ ...base, dataOperations: [{ operation: 'delete', objectApiName: 'Account', recordId: '', fieldValues: [], reason: 'No' }] }), /valid Salesforce record ID/);
  assert.throws(() => validateCodexProposal({ ...base, dataOperations: [{ operation: 'delete', objectApiName: 'Account', recordId: '001000000000001AAA', fieldValues: [{ name: 'Name', value: 'x' }], reason: 'No' }] }), /cannot include field changes/);
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

test('summarizes Codex planning failures without exposing stderr details', () => {
  const timeout = codexPlanningFailure({
    exitCode: 124,
    stderr: 'Codex planning timed out. prompt=private requirement token=top-secret'
  });
  assert.match(timeout, /time limit/i);
  assert.match(timeout, /no Salesforce changes were made/i);
  assert.doesNotMatch(timeout, /private requirement|top-secret|prompt=/i);

  const authorization = codexPlanningFailure({
    exitCode: 1,
    stderr: 'AuthorizationRequired bearer-token-value'
  });
  assert.match(authorization, /Codex session/i);
  assert.doesNotMatch(authorization, /AuthorizationRequired|bearer-token-value/i);
});

test('isolates middleware planning from personal Codex configuration', () => {
  const args = buildCodexArgs('plan.json', 'schema.json');
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ephemeral'));
  assert.deepEqual(args.slice(-1), ['-']);
});
