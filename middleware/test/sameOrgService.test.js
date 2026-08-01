import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSameVerifiedOrg, isTrustedOrgContext, resolveSameOrg } from '../src/services/sameOrgService.js';

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
  const expectedOrgId = '00D000000000SAP';
  const context = await resolveSameOrg({
    authenticatedOrgId: expectedOrgId,
    actorId: '005-user',
    registryOrgs: [org('sapa', expectedOrgId), org('other', '00D000000000OTH')],
    observed: {
      organizationId: expectedOrgId,
      instanceUrl: 'https://sapa.sandbox.my.salesforce.com/',
      username: 'sapa@example.test',
      connected: true,
      isSandbox: true
    }
  });

  assert.equal(context.expectedOrgId, expectedOrgId);
  assert.equal(context.orgRegistryId, 'sapa');
  assert.equal(context.verified.organizationId, expectedOrgId);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.allowedOperations), true);
  assert.equal(isTrustedOrgContext(context), true);
  assert.equal(context.expectedUsername, undefined);
});

test('rejects another registry org even when supplied by prompt or request body', async () => {
  await assert.rejects(
    () => resolveSameOrg({
      authenticatedOrgId: '00D000000000SAP',
      actorId: '005-user',
      requestedOrgId: '00D000000000OTH',
      registryOrgs: [org('sapa', '00D000000000SAP'), org('other', '00D000000000OTH')],
      observed: {
        organizationId: '00D000000000SAP',
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
      authenticatedOrgId: '00D000000000SAP',
      actorId: '005-user',
      registryOrgs: [org('sapa-a', '00D000000000SAP'), org('sapa-b', '00D000000000SAP')],
      observed: {
        organizationId: '00D000000000SAP',
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
    expectedOrgId: '00D000000000PRD',
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
      organizationId: '00D000000000PRD',
      instanceUrl: 'https://prod.my.salesforce.com',
      username: 'prod@example.test',
      connected: false,
      isSandbox: true
    }),
    /connected/
  );
});

test('requires complete configured and observed identity evidence', () => {
  const context = {
    orgRegistryId: 'sapa',
    salesforceAlias: 'sapa',
    expectedOrgId: '00D000000000SAP',
    environment: 'sandbox',
    instanceUrl: 'https://sapa.sandbox.my.salesforce.com',
    expectedUsername: 'sapa@example.test'
  };
  const observed = {
    organizationId: '00D000000000SAP',
    instanceUrl: 'https://sapa.sandbox.my.salesforce.com/',
    username: 'sapa@example.test',
    connected: true,
    isSandbox: true
  };

  for (const field of ['expectedOrgId', 'instanceUrl', 'expectedUsername']) {
    assert.throws(() => assertSameVerifiedOrg({ ...context, [field]: '' }, observed), /required|same Salesforce sandbox/);
  }
  for (const field of ['organizationId', 'instanceUrl', 'username']) {
    assert.throws(() => assertSameVerifiedOrg(context, { ...observed, [field]: '' }), /required|same Salesforce sandbox/);
  }
  assert.throws(() => assertSameVerifiedOrg(context, { ...observed, organizationId: '00D000000000BAD' }), /organization ID/);
  assert.throws(() => assertSameVerifiedOrg(context, { ...observed, instanceUrl: 'https://evil.example.test' }), /instance URL/);
  assert.throws(() => assertSameVerifiedOrg(context, { ...observed, username: 'other@example.test' }), /username/);
});

test('rejects malformed Salesforce org IDs instead of truncating prefixes', async () => {
  const observed = {
    organizationId: '00D000000000SAP',
    instanceUrl: 'https://sapa.sandbox.my.salesforce.com',
    username: 'sapa@example.test',
    connected: true,
    isSandbox: true
  };

  await assert.rejects(
    () => resolveSameOrg({
      authenticatedOrgId: '00D000000000SAPEXTRA',
      actorId: '005-user',
      registryOrgs: [org('sapa', '00D000000000SAP')],
      observed
    }),
    /valid Salesforce org ID/
  );
  await assert.rejects(
    () => resolveSameOrg({
      authenticatedOrgId: ' 00D000000000SAP ',
      actorId: '005-user',
      registryOrgs: [org('sapa', '00D000000000SAP')],
      observed
    }),
    /valid Salesforce org ID/
  );
});

test('deeply freezes public policy collections so callers cannot widen access', async () => {
  const context = await resolveSameOrg({
    authenticatedOrgId: '00D000000000SAP',
    actorId: '005-user',
    registryOrgs: [org('sapa', '00D000000000SAP')],
    observed: {
      organizationId: '00D000000000SAP',
      instanceUrl: 'https://sapa.sandbox.my.salesforce.com',
      username: 'sapa@example.test',
      connected: true,
      isSandbox: true
    }
  });

  assert.throws(() => context.allowedOperations.push('deploy'), /object is not extensible|read only|Cannot add/);
  assert.throws(() => context.allowedMetadataTypes.push('Profile'), /object is not extensible|read only|Cannot add/);
  assert.equal(context.allowedOperations.includes('deploy'), false);
  assert.equal(context.allowedMetadataTypes.includes('Profile'), false);
});
