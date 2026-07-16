import test from 'node:test';
import assert from 'node:assert/strict';
import { preservableCompletedWorkItems, routeValidationCorrection } from '../src/services/correctionRouting.js';
import { SPECIALIST_AGENT_IDS } from '../src/domain/specialistAgents.js';

test('proposal-only completed work is never preserved into a revision', () => {
  const job = {
    implementation: { changedFiles: [] },
    plan: { dataOperations: [] },
    workItems: [
      { assignedSpecialistAgent: SPECIALIST_AGENT_IDS.FLOW, status: 'COMPLETED', filesAffected: [] },
      { assignedSpecialistAgent: SPECIALIST_AGENT_IDS.DATA, status: 'COMPLETED', filesAffected: [] }
    ]
  };

  assert.deepEqual(preservableCompletedWorkItems(job, new Set()), []);
});

test('completed specialist work with implementation evidence can be preserved', () => {
  const flow = {
    workItemId: 'flow-1',
    assignedSpecialistAgent: SPECIALIST_AGENT_IDS.FLOW,
    status: 'COMPLETED',
    filesAffected: ['force-app/main/default/flows/Consent.flow-meta.xml'],
    implementationEvidence: { completedAt: '2026-07-16T00:00:00Z', filePaths: ['force-app/main/default/flows/Consent.flow-meta.xml'], dataOperationCount: 0 }
  };
  const job = { implementation: { changedFiles: flow.filesAffected }, plan: { dataOperations: [] }, workItems: [flow] };

  assert.deepEqual(preservableCompletedWorkItems(job, new Set()), [flow]);
  assert.deepEqual(preservableCompletedWorkItems(job, new Set([SPECIALIST_AGENT_IDS.FLOW])), []);
});

test('validation failures route corrections to the specialist owning the failing file', () => {
  const job = {
    workItems: [
      { workItemId: 'flow-1', assignedSpecialistAgent: SPECIALIST_AGENT_IDS.FLOW, filesAffected: ['force-app/main/default/flows/Consent.flow-meta.xml'] },
      { workItemId: 'field-1', assignedSpecialistAgent: SPECIALIST_AGENT_IDS.OBJECT_FIELD, filesAffected: ['force-app/main/default/objects/Contact/fields/Consent__c.field-meta.xml'] }
    ]
  };
  const route = routeValidationCorrection(job, 'Error in force-app/main/default/flows/Consent.flow-meta.xml: invalid connector');

  assert.deepEqual(route.implementationAgentIds, [SPECIALIST_AGENT_IDS.FLOW]);
  assert.ok(route.affectedAgentIds.includes(SPECIALIST_AGENT_IDS.TESTING));
  assert.ok(route.affectedAgentIds.includes(SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT));
});

test('unattributed validation failures return all changed implementation owners for review', () => {
  const job = {
    workItems: [
      { workItemId: 'flow-1', assignedSpecialistAgent: SPECIALIST_AGENT_IDS.FLOW, filesAffected: ['force-app/main/default/flows/Consent.flow-meta.xml'] },
      { workItemId: 'field-1', assignedSpecialistAgent: SPECIALIST_AGENT_IDS.OBJECT_FIELD, filesAffected: ['force-app/main/default/objects/Contact/fields/Consent__c.field-meta.xml'] }
    ]
  };
  const route = routeValidationCorrection(job, 'Salesforce validation returned an unknown component error.');

  assert.deepEqual(route.implementationAgentIds.sort(), [SPECIALIST_AGENT_IDS.FLOW, SPECIALIST_AGENT_IDS.OBJECT_FIELD].sort());
});
