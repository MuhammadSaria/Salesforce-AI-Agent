import { URL } from 'node:url';
import { loadOrgRegistry } from './orgRegistry.js';
import { verifySelectedOrg } from './sfExecutor.js';
import { isTrustedOrgContext, trustOrgContext } from './orgContextTrust.js';
import { requireSalesforceOrgId } from '../utils/salesforceId.js';

export { isTrustedOrgContext };

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
  const normalizedAuthenticatedOrgId = requireSalesforceOrgId(authenticatedOrgId, 'Authenticated Salesforce org ID');
  if (!normalizedAuthenticatedOrgId) {
    throw sameSandboxError('Authenticated Salesforce org ID is required.');
  }
  if (requestedOrgId && requireSalesforceOrgId(requestedOrgId, 'Requested Salesforce org ID') !== normalizedAuthenticatedOrgId) {
    throw sameSandboxError('Requested org IDs cannot select another Salesforce sandbox.');
  }

  const orgs = registryOrgs || (await loadOrgRegistry()).orgs;
  const matches = orgs.filter((org) =>
    org.active &&
    org.authenticationStatus === 'connected' &&
    requireSalesforceOrgId(org.expectedOrgId, 'Registry Salesforce org ID') === normalizedAuthenticatedOrgId
  );
  if (matches.length !== 1) {
    throw sameSandboxError('Expected exactly one active registry entry for the authenticated same Salesforce sandbox.');
  }
  if (requestedOrgRegistryId && requestedOrgRegistryId !== matches[0].id) {
    throw sameSandboxError('Request bodies, URLs, and prompts cannot select another Salesforce sandbox.');
  }

  const orgContext = publicContext(matches[0], actorId);
  const verificationContext = trustOrgContext({ ...orgContext, expectedUsername: matches[0].expectedUsername });
  const verified = observed
    ? assertSameVerifiedOrg(verificationContext, observed)
    : await verifySelectedOrg(verificationContext, { actor: actorId });

  return trustOrgContext(deepFreeze({ ...orgContext, verified }));
}

export function assertSameVerifiedOrg(orgContext, observed) {
  if (!orgContext || typeof orgContext !== 'object') {
    throw sameSandboxError('A verified Salesforce org context is required.');
  }
  if (String(orgContext.environment || '').toLowerCase() === 'production' || orgContext.productionApprovalRequired === true) {
    throw sameSandboxError('Production Salesforce orgs are not allowed in Phase 1.');
  }
  const expectedOrgId = requireSalesforceOrgId(orgContext.expectedOrgId, 'Configured Salesforce org ID');
  const observedOrgId = requireSalesforceOrgId(observed?.organizationId || observed?.orgId || observed?.id, 'Observed Salesforce org ID');
  const expectedInstanceUrl = requireString(orgContext.instanceUrl, 'Configured instance URL');
  const observedInstanceUrl = requireString(observed?.instanceUrl, 'Observed instance URL');
  const expectedUsername = requireString(orgContext.expectedUsername, 'Configured username');
  const observedUsername = requireString(observed?.username, 'Observed username');
  if (!observed?.connected) {
    throw sameSandboxError('Salesforce CLI org must be connected.');
  }
  if (observedOrgId !== expectedOrgId) {
    throw sameSandboxError('Salesforce organization ID does not match the authenticated same Salesforce sandbox.');
  }
  if (normalizeUrl(expectedInstanceUrl) !== normalizeUrl(observedInstanceUrl)) {
    throw sameSandboxError('Salesforce instance URL does not match the authenticated same Salesforce sandbox.');
  }
  if (expectedUsername.toLowerCase() !== observedUsername.toLowerCase()) {
    throw sameSandboxError('Salesforce username does not match the configured integration user.');
  }
  if (observed.isProduction === true || observed.environment === 'production') {
    throw sameSandboxError('Production Salesforce orgs are not allowed in Phase 1.');
  }
  if (observed.isSandbox === false && !['developer', 'scratch'].includes(String(orgContext.environment || '').toLowerCase())) {
    throw sameSandboxError('Salesforce CLI org must be a non-production sandbox.');
  }

  return deepFreeze({
    organizationId: observedOrgId,
    instanceUrl: observedInstanceUrl,
    username: observedUsername,
    connected: true,
    environment: orgContext.environment,
    verifiedAt: observed.verifiedAt || new Date().toISOString()
  });
}

function publicContext(org, actorId) {
  const context = {
    orgRegistryId: org.id,
    salesforceAlias: org.salesforceAlias,
    expectedOrgId: requireSalesforceOrgId(org.expectedOrgId, 'Registry Salesforce org ID'),
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
  return deepFreeze(Object.fromEntries(PUBLIC_CONTEXT_FIELDS.concat(['selectionSource', 'selectionTimestamp', 'selectingUser'])
    .map((field) => [field, context[field]])));
}

function sameSandboxError(message) {
  const error = new Error(`${message} All direct Phase 1 actions must use the authenticated same Salesforce sandbox.`);
  error.code = 'SAME_ORG_REQUIRED';
  error.statusCode = 409;
  return error;
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    throw sameSandboxError('Salesforce instance URL is invalid.');
  }
}

function requireString(value, label) {
  const text = String(value || '').trim();
  if (!text) throw sameSandboxError(`${label} is required.`);
  return text;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
