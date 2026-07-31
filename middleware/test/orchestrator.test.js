import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECIALIST_AGENT_IDS,
  WORK_ITEM_STATUSES,
  ownerForFile,
  selectAffectedSpecialistAgents,
  selectSpecialistAgents,
  workItemCompletionPath
} from '../src/domain/specialistAgents.js';
import {
  approveSpecialistWorkItems,
  buildSpecialistOrchestration,
  overallSpecialistStatus,
  workItemForFile
} from '../src/services/orchestrator.js';

const orgContext = {
  orgRegistryId: 'test-sandbox',
  expectedOrgId: '00D000000000001AAA',
  displayName: 'Test Sandbox',
  environment: 'sandbox'
};

test('field work selects only the relevant implementation specialists and common review agents', () => {
  const selected = selectSpecialistAgents({ summary: 'Add a Donor Status picklist field to Contact.' });
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.OBJECT_FIELD));
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS));
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.UI_METADATA));
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.TESTING));
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT));
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.DOCUMENTATION_EXPLANATION));
  assert.equal(selected.includes(SPECIALIST_AGENT_IDS.APEX), false);
  assert.equal(selected.includes(SPECIALIST_AGENT_IDS.FLOW), false);
});

test('revision impact does not reopen a metadata owner for a reference-only mention', () => {
  const selected = selectAffectedSpecialistAgents('Display the existing field in the LWC and grant access through the Fundraising Manager permission set.');
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.LWC));
  assert.ok(selected.includes(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS));
  assert.equal(selected.includes(SPECIALIST_AGENT_IDS.OBJECT_FIELD), false);
  assert.equal(selected.includes(SPECIALIST_AGENT_IDS.FLOW), false);
});

test('orchestrator creates dependency-aware work items and one owner per file', () => {
  const result = exampleOrchestration();
  const byAgent = new Map(result.workItems.map((item) => [item.assignedSpecialistAgent, item]));
  const objectItem = byAgent.get(SPECIALIST_AGENT_IDS.OBJECT_FIELD);
  const flowItem = byAgent.get(SPECIALIST_AGENT_IDS.FLOW);
  const securityItem = byAgent.get(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS);
  const testingItem = byAgent.get(SPECIALIST_AGENT_IDS.TESTING);
  const validationItem = byAgent.get(SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT);

  assert.ok(flowItem.dependencies.includes(objectItem.workItemId));
  assert.ok(securityItem.dependencies.includes(objectItem.workItemId));
  assert.ok(securityItem.dependencies.includes(flowItem.workItemId));
  assert.ok(testingItem.dependencies.includes(flowItem.workItemId));
  assert.ok(validationItem.dependencies.includes(testingItem.workItemId));
  assert.ok(result.orchestration.executionOrder.indexOf(objectItem.workItemId) < result.orchestration.executionOrder.indexOf(flowItem.workItemId));
  assert.equal(result.fileOwnership.length, 4);
  assert.equal(new Set(result.fileOwnership.map((item) => item.path)).size, 4);
  assert.equal(workItemForFile(result.workItems, 'force-app/main/default/flows/Update_Donor_Status.flow-meta.xml').assignedSpecialistAgent, SPECIALIST_AGENT_IDS.FLOW);
  assert.equal(result.plan.specialistSections.length, result.workItems.length);
  assert.ok(result.specialistMessages.every((message) => message.parentJobId === 'job-1' && message.messageType === 'DEPENDENCY_FOUND'));
});

test('one unified approval approves all proposed specialist work without creating agent approvals', () => {
  const result = exampleOrchestration();
  const approved = approveSpecialistWorkItems(result.workItems, 'approval-1');
  assert.ok(approved.every((item) => [WORK_ITEM_STATUSES.APPROVED, WORK_ITEM_STATUSES.COMPLETED].includes(item.status)));
  assert.ok(approved.filter((item) => item.status === WORK_ITEM_STATUSES.APPROVED).every((item) => item.approvalId === 'approval-1'));
  assert.equal(overallSpecialistStatus(approved), 'PENDING');
});

test('specialist completion uses the required intermediate state after implementation', () => {
  assert.deepEqual(
    workItemCompletionPath(WORK_ITEM_STATUSES.IMPLEMENTING),
    [WORK_ITEM_STATUSES.IMPLEMENTATION_COMPLETE, WORK_ITEM_STATUSES.COMPLETED]
  );
  assert.deepEqual(
    workItemCompletionPath(WORK_ITEM_STATUSES.APPROVED),
    [WORK_ITEM_STATUSES.COMPLETED]
  );
});

test('specialist path boundaries reject unsafe metadata and distinguish compact layouts', () => {
  assert.equal(ownerForFile('force-app/main/default/objects/Contact/fields/Donor_Status__c.field-meta.xml'), SPECIALIST_AGENT_IDS.OBJECT_FIELD);
  assert.equal(ownerForFile('force-app/main/default/objects/Contact/compactLayouts/Contact.compactLayout-meta.xml'), SPECIALIST_AGENT_IDS.UI_METADATA);
  assert.equal(ownerForFile('force-app/main/default/reports/Test.report-meta.xml'), SPECIALIST_AGENT_IDS.GENERAL_METADATA);
  assert.throws(() => buildSpecialistOrchestration(
    { jobId: 'job-2', jiraIssueKey: 'TA-2', orgContext },
    { summary: 'Change an unsupported metadata file.' },
    { primaryMetadata: [], dependencies: [], hash: 'scope-2' },
    basePlan([{ operation: 'create', path: 'force-app/main/default/scripts/deploy.ps1', content: 'blocked', reason: 'Unsafe script' }])
  ), /No specialist is allowed/);
});

test('duplicate file operations are rejected before implementation', () => {
  const path = 'force-app/main/default/flows/Duplicate.flow-meta.xml';
  assert.throws(() => buildSpecialistOrchestration(
    { jobId: 'job-3', jiraIssueKey: 'TA-3', orgContext },
    { summary: 'Create a Flow.' },
    { primaryMetadata: [{ type: 'Flow', apiName: 'Duplicate' }], dependencies: [], hash: 'scope-3' },
    basePlan([
      { operation: 'create', path, content: '<Flow/>', reason: 'Create Flow' },
      { operation: 'modify', path, content: '<Flow/>', reason: 'Modify Flow' }
    ])
  ), /Multiple proposed operations target/);
});

function exampleOrchestration() {
  const files = [
    { operation: 'create', path: 'force-app/main/default/objects/Contact/fields/Donor_Status__c.field-meta.xml', content: '<CustomField/>', reason: 'Create the Donor Status field.' },
    { operation: 'create', path: 'force-app/main/default/flows/Update_Donor_Status.flow-meta.xml', content: '<Flow/>', reason: 'Set Donor Status from the approved business rule.' },
    { operation: 'modify', path: 'force-app/main/default/layouts/Contact-Contact Layout.layout-meta.xml', content: '<Layout/>', reason: 'Display Donor Status on the Contact layout.' },
    { operation: 'modify', path: 'force-app/main/default/permissionsets/Fundraising_User.permissionset-meta.xml', content: '<PermissionSet/>', reason: 'Grant least-privilege field access.' }
  ];
  return buildSpecialistOrchestration(
    { jobId: 'job-1', jiraIssueKey: 'TA-1', orgContext, nextPlanVersion: 1 },
    { summary: 'Create Donor Status on Contact, update it through a Flow, display it, and grant Fundraising User access.', acceptanceCriteria: 'The field is populated and visible to approved users.' },
    {
      primaryMetadata: [
        { type: 'CustomField', apiName: 'Contact.Donor_Status__c' },
        { type: 'Flow', apiName: 'Update_Donor_Status' },
        { type: 'Layout', apiName: 'Contact-Contact Layout' },
        { type: 'PermissionSet', apiName: 'Fundraising_User' }
      ],
      dependencies: [],
      hash: 'scope-1'
    },
    basePlan(files)
  );
}

function basePlan(fileOperations) {
  return {
    planVersion: 1,
    fileOperations,
    dataOperations: [],
    testingStrategy: ['Verify field behavior and access.'],
    validationStrategy: 'Validate the exact package.',
    deploymentStrategy: 'Deploy after separate approval.',
    assumptions: [],
    risks: [],
    estimatedRiskLevel: 'MEDIUM'
  };
}
