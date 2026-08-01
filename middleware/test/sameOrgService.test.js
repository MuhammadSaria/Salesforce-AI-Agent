import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSameVerifiedOrg, resolveSameOrg } from '../src/services/sameOrgService.js';

function org(id, expectedOrgId, options = {}) {
  return {
    id,
    active: options.active !== false,
    authenticationStatus: options.authenticationStatus || 'connected',
    expectedOrgId,
    salesforceAlias: options.salesforceAlias || id,
    environment: options.environment || 'sandbox',
    instanceUrl: options.instanceUrl || `https://${id}.sandbox.my.salesforce.com`,
    expectedUsername: options.expectedUsername || `${id}@example.test`,
    displayName: options.displayName || id,
    customerName: options.customerName || id,
    deploymentPermission: 'allowed',
    dataMutationPermission: 'allowed',
    recordDeletionPermission: 'blocked',
    allowedDataObjects: ['*'],
    restrictedDataObjects: ['User'],
    maximumDataOperations: 10,
    maximumDeleteOperations: 1,
    productionApprovalRequired: false,
    allowedOperations: ['read', 'retrieve', 'validate'],
    allowedMetadataTypes: ['Flow'],
    restrictedMetadataTypes: ['Profile']
  };
}

test('resolves exactly the registry entry matching the authenticated Salesforce org', async () => {
  const context = await resolveSameOrg({
    authenticatedOrgId: '00D-SAPA',
    actorId: '005-user',
    registryOrgs: [org('sapa', '00D-SAPA'), org('other', '00D-OTHER')],
    observed: {
      organizationId: '00D-SAPA',
      instanceUrl: 'https://sapa.sandbox.my.salesforce.com/',
      username: 'sapa@example.test',
      connected: true,
      isSandbox: true
    }
  });

  assert.equal(context.expectedOrgId, '00D-SAPA');
  assert.equal(context.orgRegistryId, 'sapa');
  assert.equal(context.verified.organizationId, '00D-SAPA');
  assert.equal(Object.isFrozen(context), true);
  assert.equal(context.expectedUsername, undefined);
});

test('rejects another registry org even when supplied by prompt or request body', async () => {
  await assert.rejects(
    () => resolveSameOrg({
      authenticatedOrgId: '00D-SAPA',
      actorId: '005-user',
      requestedOrgId: '00D-OTHER',
      registryOrgs: [org('sapa', '00D-SAPA'), org('other', '00D-OTHER')],
      observed: {
        organizationId: '00D-SAPA',
        instanceUrl: 'https://sapa.sandbox.my.salesforce.com',
        username: 'sapa@example.test',
        connected: true,
        isSandbox: true
      }
    }),
    /same Salesforce sandbox/
  );
});

test('rejects duplicate active registry entries for the authenticated org', async () => {
  await assert.rejects(
    () => resolveSameOrg({
      authenticatedOrgId: '00D-SAPA',
      actorId: '005-user',
      registryOrgs: [org('sapa-a', '00D-SAPA'), org('sapa-b', '00D-SAPA')],
      observed: {
        organizationId: '00D-SAPA',
        instanceUrl: 'https://sapa-a.sandbox.my.salesforce.com',
        username: 'sapa-a@example.test',
        connected: true,
        isSandbox: true
      }
    }),
    /exactly one active registry entry/
  );
});

test('rejects production and disconnected observed Salesforce contexts', () => {
  const context = {
    orgRegistryId: 'prod',
    salesforceAlias: 'prod',
    expectedOrgId: '00D-PROD',
    environment: 'production',
    instanceUrl: 'https://prod.my.salesforce.com',
    expectedUsername: 'prod@example.test'
  };

  assert.throws(
    () => assertSameVerifiedOrg(context, {
      organizationId: '00D-PROD',
      instanceUrl: 'https://prod.my.salesforce.com',
      username: 'prod@example.test',
      connected: true,
      isSandbox: false
    }),
    /Production Salesforce orgs are not allowed/
  );

  assert.throws(
    () => assertSameVerifiedOrg({ ...context, environment: 'sandbox' }, {
      organizationId: '00D-PROD',
      instanceUrl: 'https://prod.my.salesforce.com',
      username: 'prod@example.test',
      connected: false,
      isSandbox: true
    }),
    /connected/
  );
});
