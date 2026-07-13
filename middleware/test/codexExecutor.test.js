import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCodexProposal } from '../src/services/codexExecutor.js';

const proposal = (file) => ({
  proposedImplementation: 'Update the approved Salesforce source.',
  files: [file],
  testingStrategy: ['Run relevant tests.'],
  risks: [],
  assumptions: []
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
