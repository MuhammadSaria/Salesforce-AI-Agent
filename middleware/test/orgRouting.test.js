import test from 'node:test';
import assert from 'node:assert/strict';
import { getRegisteredOrg, isDataObjectAllowed, selectOrgFromRegistry } from '../src/services/orgRegistry.js';

function org(id, projectKeys, options = {}) {
  return {
    id,
    active: options.active !== false,
    authenticationStatus: options.authenticationStatus || 'connected',
    expectedOrgId: options.expectedOrgId || `00D${id}`,
    jiraProjectKeys: projectKeys,
    jiraComponents: options.components || [],
    jiraCustomFieldMappings: options.customFields || {},
    environment: 'sandbox',
    customerName: id,
    repositoryPaths: [],
    displayName: id,
    instanceUrl: `https://${id}.example.com`,
    deploymentPermission: 'blocked',
    productionApprovalRequired: false
  };
}

test('a Jira project mapped to one connected org selects only that org', () => {
  const result = selectOrgFromRegistry([org('sapa', ['SAPA']), org('read', ['READ'])], {
    context: { jiraProjectKey: 'SAPA' }
  });
  assert.equal(result.status, 'selected');
  assert.equal(result.org.id, 'sapa');
  assert.deepEqual(result.evidence, ['jiraProjectKey']);
});

test('project and component signals are intersected instead of unioned', () => {
  const result = selectOrgFromRegistry([
    org('sapa-dev', ['SAPA'], { components: ['Development'] }),
    org('sapa-uat', ['SAPA'], { components: ['UAT'] })
  ], { context: { jiraProjectKey: 'SAPA', jiraComponents: ['UAT'] } });
  assert.equal(result.status, 'selected');
  assert.equal(result.org.id, 'sapa-uat');
});

test('configured Jira custom fields can identify the exact org', () => {
  const result = selectOrgFromRegistry([
    org('sapa-dev', ['SAPA'], { customFields: { customfield_10001: ['DEV'] } }),
    org('sapa-uat', ['SAPA'], { customFields: { customfield_10001: ['UAT'] } })
  ], { context: { jiraProjectKey: 'SAPA', jiraCustomFields: { customfield_10001: 'DEV' } } });
  assert.equal(result.status, 'selected');
  assert.equal(result.org.id, 'sapa-dev');
});

test('unmapped and disconnected orgs are never selected automatically', () => {
  const result = selectOrgFromRegistry([
    org('connected', []),
    org('disconnected', ['SAPA'], { authenticationStatus: 'disconnected' })
  ], { context: { jiraProjectKey: 'SAPA' } });
  assert.equal(result.status, 'none');
  assert.deepEqual(result.candidates.map((candidate) => candidate.orgRegistryId), ['connected']);
});

test('conflicting trusted signals pause for org selection', () => {
  const result = selectOrgFromRegistry([
    org('one', ['SAPA'], { components: ['One'] }),
    org('two', ['READ'], { components: ['Two'] })
  ], { context: { jiraProjectKey: 'SAPA', jiraComponents: ['Two'] } });
  assert.equal(result.status, 'none');
});

test('wildcard data access permits business objects but retains the security denylist', () => {
  const context = { allowedDataObjects: ['*'], restrictedDataObjects: ['User', 'PermissionSetAssignment'] };
  assert.equal(isDataObjectAllowed(context, 'Invoice__c'), true);
  assert.equal(isDataObjectAllowed(context, 'Order'), true);
  assert.equal(isDataObjectAllowed(context, 'User'), false);
  assert.equal(isDataObjectAllowed(context, 'PermissionSetAssignment'), false);
});

test('Providus developer org permits approved Opportunity creates only', async () => {
  const context = await getRegisteredOrg('providus_orgfarm_dev');

  assert.equal(context.dataMutationPermission, 'allowed');
  assert.equal(context.recordDeletionPermission, 'blocked');
  assert.equal(context.maximumDataOperations, 10);
  assert.equal(context.allowedOperations.includes('data-create'), true);
  assert.equal(context.allowedOperations.includes('data-update'), false);
  assert.equal(context.allowedOperations.includes('data-delete'), false);
  assert.equal(isDataObjectAllowed(context, 'Opportunity'), true);
  assert.equal(isDataObjectAllowed(context, 'Account'), false);
});
