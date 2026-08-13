import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFlowSource } from '../src/validation/flowValidator.js';
import { connectedFlowXml } from './fixtures/connectedFlow.js';

const ORG = '00Dg500000E07e9EAB';

test('accepts complete connected Draft Flow source bound to current trusted evidence', () => {
  const validated = validateFlowSource(validInput());
  assert.equal(validated.reachable.has('Assign_First'), true);
  assert.equal(validated.reachable.has('Assign_Increment'), true);
});

for (const [name, mutate] of [
  ['missing label', (xml) => xml.replace('<label>Assign Installment</label>', '')],
  ['missing API version', (xml) => xml.replace('<apiVersion>65.0</apiVersion>', '')],
  ['wrong process type', (xml) => xml.replace('<processType>AutoLaunchedFlow</processType>', '<processType>Flow</processType>')]
]) {
  test(`rejects Flow with ${name}`, () => {
    const input = validInput();
    input.content = mutate(input.content);
    assert.throws(() => validateFlowSource(input), (error) => error.code === 'SPECIALIST_FLOW_INVALID');
  });
}

test('preserves the stable inactive-Flow error code', () => {
  const input = validInput();
  input.content = input.content.replace('<status>Draft</status>', '<status>Active</status>');
  assert.throws(() => validateFlowSource(input), (error) => error.code === 'FLOW_MUST_BE_INACTIVE');
});

for (const [name, mutate] of [
  ['missing evidence', (input) => { input.inspection.evidence = []; }],
  ['stale evidence', (input) => { input.inspection.evidence[0].stale = true; }],
  ['wrong-org evidence', (input) => { input.inspection.evidence[0].sourceOrgId = '00Dg500000E07fAEAR'; }]
]) {
  test(`rejects ${name} before trusting Flow semantics`, () => {
    const input = validInput();
    mutate(input);
    assert.throws(() => validateFlowSource(input), (error) => error.code === 'SPECIALIST_EVIDENCE_INVALID');
  });
}

function validInput() {
  return {
    content: connectedFlowXml().replace('</apiVersion>', '</apiVersion><label>Assign Installment</label><processType>AutoLaunchedFlow</processType>'),
    approvedBehavior: { sourceOrgId: ORG, flowApiName: 'Assign_Installment', objectApiName: 'GiftTransaction', installmentField: 'Installment_Number__c', evidenceIds: ['relationship', 'status-completed'] },
    inspection: {
      sourceOrgId: ORG,
      evidence: [
        { evidenceId: 'relationship', kind: 'RELATIONSHIP', sourceOrgId: ORG, objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', targetObjectApiName: 'GiftCommitment', componentType: 'CustomField', componentApiName: 'GiftTransaction.GiftCommitmentId', active: true, stale: false, observedAt: new Date().toISOString() },
        { evidenceId: 'status-completed', kind: 'STATUS_VALUE', sourceOrgId: ORG, objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Completed', componentType: 'CustomField', componentApiName: 'GiftTransaction.Status', active: true, stale: false, observedAt: new Date().toISOString() }
      ]
    }
  };
}
