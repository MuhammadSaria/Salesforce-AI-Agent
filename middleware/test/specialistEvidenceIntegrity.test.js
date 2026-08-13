import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpecialistEvidence } from '../src/domain/specialistEvidence.js';

const NOW = new Date('2026-08-13T12:00:00.000Z');
const ORG = '00Dg500000E07e9EAB';

test('accepts exact current component-bound Flow evidence', () => {
  const evidence = validateSpecialistEvidence(validEvidence(), { sourceOrgId: ORG, now: NOW, approvedComponents: [{ metadataType: 'Flow', apiName: 'Assign_Installment' }], specialistId: 'FLOW' });
  assert.equal(evidence.length, 3);
});

for (const [name, mutate] of [
  ['wrong org', (items) => { items[0].sourceOrgId = '00Dg500000E07fAEAR'; }],
  ['missing org', (items) => { delete items[0].sourceOrgId; }],
  ['inactive status', (items) => { items[1].active = false; }],
  ['stale evidence', (items) => { items[0].stale = true; }],
  ['future evidence', (items) => { items[0].observedAt = '2026-08-13T13:00:00.000Z'; }],
  ['duplicate ID', (items) => { items[1].evidenceId = items[0].evidenceId; }],
  ['unknown kind', (items) => { items[0].kind = 'COMMAND'; }],
  ['unrelated object', (items) => { items[0].objectApiName = 'Account'; }],
  ['unrelated relationship', (items) => { items[0].targetObjectApiName = 'Account'; }],
  ['unrelated retrieved Flow', (items) => { items[2].componentApiName = 'Other_Flow'; }],
  ['unexpected property', (items) => { items[0].credentials = { token: 'secret' }; }]
]) {
  test(`rejects ${name}`, () => {
    const items = validEvidence(); mutate(items);
    assert.throws(() => validateSpecialistEvidence(items, { sourceOrgId: ORG, now: NOW, approvedComponents: [{ metadataType: 'Flow', apiName: 'Assign_Installment' }], specialistId: 'FLOW' }), (error) => error.code === 'SPECIALIST_EVIDENCE_INVALID');
  });
}

test('rejects oversized retrieved source', () => {
  const items = validEvidence(); items[2].retrievedSource = 'x'.repeat(500001);
  assert.throws(() => validateSpecialistEvidence(items, { sourceOrgId: ORG, now: NOW, approvedComponents: [{ metadataType: 'Flow', apiName: 'Assign_Installment' }], specialistId: 'FLOW' }), (error) => error.code === 'SPECIALIST_EVIDENCE_INVALID');
});

function validEvidence() {
  return [
    { evidenceId: 'relationship', kind: 'RELATIONSHIP', objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', targetObjectApiName: 'GiftCommitment', componentType: 'CustomField', componentApiName: 'GiftTransaction.GiftCommitmentId', sourceOrgId: ORG, active: true, stale: false, observedAt: '2026-08-13T11:59:00.000Z' },
    { evidenceId: 'status', kind: 'STATUS_VALUE', objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Completed', componentType: 'CustomField', componentApiName: 'GiftTransaction.Status', sourceOrgId: ORG, active: true, stale: false, observedAt: '2026-08-13T11:59:00.000Z' },
    { evidenceId: 'flow', kind: 'RETRIEVED_COMPONENT', componentType: 'Flow', componentApiName: 'Assign_Installment', retrievedSource: '<Flow/>', sourceOrgId: ORG, active: true, stale: false, observedAt: '2026-08-13T11:59:00.000Z' }
  ];
}
