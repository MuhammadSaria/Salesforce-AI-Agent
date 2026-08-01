import { loadOrgRegistry } from './orgRegistry.js';
import { verifySelectedOrg } from './sfExecutor.js';

const PUBLIC_CONTEXT_FIELDS = [
  'orgRegistryId',
  'salesforceAlias',
  'expectedOrgId',
  'environment',
  'instanceUrl',
  'displayName',
  'customerName',
  'deploymentPermission',
  'dataMutationPermission',
  'recordDeletionPermission',
  'allowedDataObjects',
  'restrictedDataObjects',
  'maximumDataOperations',
  'maximumDeleteOperations',
  'productionApprovalRequired',
  'allowedOperations',
  'allowedMetadataTypes',
  'restrictedMetadataTypes'
];

export async function resolveSameOrg({
  authenticatedOrgId,
  actorId,
  requestedOrgId,
  requestedOrgRegistryId,
  registryOrgs,
  observed
}) {
  if (!authenticatedOrgId) {
    throw sameSandboxError('Authenticated Salesforce org ID is required.');
  }
  if (requestedOrgId && normalizeOrgId(requestedOrgId) !== normalizeOrgId(authenticatedOrgId)) {
    throw sameSandboxError('Requested org IDs cannot select another Salesforce sandbox.');
  }

  const orgs = registryOrgs || (await loadOrgRegistry()).orgs;
  const matches = orgs.filter((org) =>
    org.active &&
    org.authenticationStatus === 'connected' &&
    normalizeOrgId(org.expectedOrgId) === normalizeOrgId(authenticatedOrgId)
  );
  if (matches.length !== 1) {
    throw sameSandboxError('Expected exactly one active registry entry for the authenticated same Salesforce sandbox.');
  }
  if (requestedOrgRegistryId && requestedOrgRegistryId !== matches[0].id) {
    throw sameSandboxError('Request bodies, URLs, and prompts cannot select another Salesforce sandbox.');
  }

  const orgContext = publicContext(matches[0], actorId);
  const verificationContext = { ...orgContext, expectedUsername: matches[0].expectedUsername };
  const verified = observed
    ? assertSameVerifiedOrg(verificationContext, observed)
    : await verifySelectedOrg(verificationContext, { actor: actorId });

  return Object.freeze({ ...orgContext, verified: Object.freeze(verified) });
}

export function assertSameVerifiedOrg(orgContext, observed) {
  if (!orgContext || typeof orgContext !== 'object') {
    throw sameSandboxError('A verified Salesforce org context is required.');
  }
  if (String(orgContext.environment || '').toLowerCase() === 'production' || orgContext.productionApprovalRequired === true) {
    throw sameSandboxError('Production Salesforce orgs are not allowed in Phase 1.');
  }
  if (!observed?.connected) {
    throw sameSandboxError('Salesforce CLI org must be connected.');
  }
  if (normalizeOrgId(observed.organizationId || observed.orgId || observed.id) !== normalizeOrgId(orgContext.expectedOrgId)) {
    throw sameSandboxError('Salesforce organization ID does not match the authenticated same Salesforce sandbox.');
  }
  if (orgContext.instanceUrl && observed.instanceUrl && normalizeUrl(orgContext.instanceUrl) !== normalizeUrl(observed.instanceUrl)) {
    throw sameSandboxError('Salesforce instance URL does not match the authenticated same Salesforce sandbox.');
  }
  if (orgContext.expectedUsername && observed.username && String(orgContext.expectedUsername).toLowerCase() !== String(observed.username).toLowerCase()) {
    throw sameSandboxError('Salesforce username does not match the configured integration user.');
  }
  if (observed.isProduction === true || observed.environment === 'production') {
    throw sameSandboxError('Production Salesforce orgs are not allowed in Phase 1.');
  }
  if (observed.isSandbox === false && !['developer', 'scratch'].includes(String(orgContext.environment || '').toLowerCase())) {
    throw sameSandboxError('Salesforce CLI org must be a non-production sandbox.');
  }

  return Object.freeze({
    organizationId: observed.organizationId || observed.orgId || observed.id,
    instanceUrl: observed.instanceUrl,
    username: observed.username,
    connected: true,
    environment: orgContext.environment,
    verifiedAt: observed.verifiedAt || new Date().toISOString()
  });
}

function publicContext(org, actorId) {
  const context = {
    orgRegistryId: org.id,
    salesforceAlias: org.salesforceAlias,
    expectedOrgId: org.expectedOrgId,
    environment: org.environment,
    instanceUrl: org.instanceUrl,
    displayName: org.displayName,
    customerName: org.customerName,
    deploymentPermission: org.deploymentPermission,
    dataMutationPermission: org.dataMutationPermission,
    recordDeletionPermission: org.recordDeletionPermission,
    allowedDataObjects: [...(org.allowedDataObjects || [])],
    restrictedDataObjects: [...(org.restrictedDataObjects || [])],
    maximumDataOperations: org.maximumDataOperations,
    maximumDeleteOperations: org.maximumDeleteOperations,
    productionApprovalRequired: org.productionApprovalRequired,
    allowedOperations: [...(org.allowedOperations || [])],
    allowedMetadataTypes: [...(org.allowedMetadataTypes || [])],
    restrictedMetadataTypes: [...(org.restrictedMetadataTypes || [])],
    selectionSource: 'authenticatedSalesforceOrgId',
    selectionTimestamp: new Date().toISOString(),
    selectingUser: actorId || 'system'
  };
  return Object.freeze(Object.fromEntries(PUBLIC_CONTEXT_FIELDS.concat(['selectionSource', 'selectionTimestamp', 'selectingUser'])
    .map((field) => [field, context[field]])));
}

function sameSandboxError(message) {
  const error = new Error(`${message} All direct Phase 1 actions must use the authenticated same Salesforce sandbox.`);
  error.code = 'SAME_ORG_REQUIRED';
  error.statusCode = 409;
  return error;
}

function normalizeOrgId(value) {
  return String(value || '').trim().slice(0, 15).toUpperCase();
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/$/, '').toLowerCase();
}
