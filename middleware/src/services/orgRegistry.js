import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config.js';

const VALID_ENVIRONMENTS = new Set(['developer', 'scratch', 'sandbox', 'partial-copy', 'full-copy', 'production']);
let cachedRegistry;

export async function loadOrgRegistry() {
  if (cachedRegistry) {
    return cachedRegistry;
  }

  const registryText = await readFile(config.orgRegistryPath, 'utf8');
  const parsed = JSON.parse(registryText);
  const orgs = Array.isArray(parsed.orgs) ? parsed.orgs.map(normalizeOrg).filter(Boolean) : [];
  cachedRegistry = { orgs };
  return cachedRegistry;
}

export async function selectOrgForJob(job) {
  const registry = await loadOrgRegistry();
  const activeOrgs = registry.orgs.filter((org) => org.active);
  const context = job.context || {};
  const candidates = [];

  const addMatches = (matches, source) => {
    for (const org of matches) {
      if (!candidates.some((candidate) => candidate.org.id === org.id)) {
        candidates.push({ org, source });
      }
    }
  };

  if (context.selectedOrgRegistryId) {
    const explicitlyAllowed = activeOrgs.filter((org) => org.id === context.selectedOrgRegistryId);
    return selectionResult(explicitlyAllowed.map((org) => ({ org, source: 'explicitUserSelection' })));
  }

  if (job.orgId) {
    const exact = activeOrgs.filter((org) => sameOrgId(org.expectedOrgId, job.orgId));
    if (exact.length) return selectionResult(exact.map((org) => ({ org, source: 'authenticatedSalesforceOrgId' })));
  }

  if (context.jiraProjectKey) {
    addMatches(
      activeOrgs.filter((org) => org.jiraProjectKeys.includes(String(context.jiraProjectKey).toUpperCase())),
      'jiraProjectKey'
    );
  }

  if (context.jiraComponent) {
    addMatches(activeOrgs.filter((org) => org.jiraComponents.includes(String(context.jiraComponent))), 'jiraComponent');
  }

  if (context.customerName) {
    addMatches(
      activeOrgs.filter((org) => normalizeText(org.customerName) === normalizeText(context.customerName)),
      'customerName'
    );
  }

  if (context.environment) {
    const scoped = candidates.filter((candidate) => candidate.org.environment === String(context.environment).toLowerCase());
    if (scoped.length > 0) {
      return selectionResult(scoped, 'environment');
    }
  }

  if (context.repositoryPath) {
    const repositoryPath = resolve(String(context.repositoryPath));
    addMatches(
      activeOrgs.filter((org) => org.repositoryPaths.some((path) => repositoryPath.startsWith(resolve(config.projectRoot, path)))),
      'repositoryMapping'
    );
  }

  return selectionResult(candidates);
}

export async function listPublicOrgs() {
  const registry = await loadOrgRegistry();
  return registry.orgs.filter((org) => org.active).map(publicOrgOption);
}

export async function getRegisteredOrg(orgRegistryId) {
  const registry = await loadOrgRegistry();
  return registry.orgs.find((org) => org.id === orgRegistryId && org.active) || null;
}

export function buildOrgContext(selection, job) {
  return {
    orgRegistryId: selection.org.id,
    salesforceAlias: selection.org.salesforceAlias,
    expectedOrgId: selection.org.expectedOrgId,
    environment: selection.org.environment,
    instanceUrl: selection.org.instanceUrl,
    expectedUsername: selection.org.expectedUsername,
    displayName: selection.org.displayName,
    customerName: selection.org.customerName,
    deploymentPermission: selection.org.deploymentPermission,
    productionApprovalRequired: selection.org.productionApprovalRequired,
    allowedOperations: selection.org.allowedOperations,
    allowedMetadataTypes: selection.org.allowedMetadataTypes,
    restrictedMetadataTypes: selection.org.restrictedMetadataTypes,
    selectionSource: selection.source,
    selectionTimestamp: new Date().toISOString(),
    selectingUser: job.userId || job.context?.username || 'system'
  };
}

export function publicOrgOption(org) {
  return {
    orgRegistryId: org.id,
    displayName: org.displayName,
    customerName: org.customerName,
    environment: org.environment,
    expectedOrgId: org.expectedOrgId,
    instanceUrl: org.instanceUrl,
    deploymentPermission: org.deploymentPermission,
    productionApprovalRequired: org.productionApprovalRequired,
    authenticationStatus: org.authenticationStatus
  };
}

function selectionResult(candidates, overrideSource) {
  if (candidates.length === 1) {
    return {
      status: 'selected',
      org: candidates[0].org,
      source: overrideSource || candidates[0].source
    };
  }

  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates: candidates.map((candidate) => publicOrgOption(candidate.org))
    };
  }

  return { status: 'none', candidates: [] };
}

function normalizeOrg(org) {
  if (!org || typeof org !== 'object') {
    return null;
  }

  const environment = String(org.environment || '').toLowerCase();
  if (!VALID_ENVIRONMENTS.has(environment)) {
    throw new Error(`Invalid Salesforce environment for org ${org.id || org.displayName}.`);
  }

  return {
    id: requiredString(org.id, 'Org registry ID'),
    displayName: requiredString(org.displayName, 'Display name'),
    customerName: requiredString(org.customerName, 'Customer name'),
    salesforceAlias: requiredString(org.salesforceAlias, 'Salesforce CLI alias'),
    expectedOrgId: requiredString(org.expectedOrgId, 'Expected Salesforce Organization ID'),
    environment,
    instanceUrl: requiredString(org.instanceUrl, 'Instance URL'),
    expectedUsername: String(org.expectedUsername || ''),
    jiraProjectKeys: normalizeArray(org.jiraProjectKeys).map((key) => key.toUpperCase()),
    jiraComponents: normalizeArray(org.jiraComponents),
    jiraCustomFieldMappings: org.jiraCustomFieldMappings && typeof org.jiraCustomFieldMappings === 'object' ? org.jiraCustomFieldMappings : {},
    repositoryPaths: normalizeArray(org.repositoryPaths),
    localProjectPath: String(org.localProjectPath || ''),
    authenticationStatus: String(org.authenticationStatus || 'unknown'),
    deploymentPermission: String(org.deploymentPermission || 'blocked'),
    productionApprovalRequired: org.productionApprovalRequired === true || environment === 'production',
    active: org.active !== false,
    allowedOperations: normalizeArray(org.allowedOperations),
    allowedMetadataTypes: normalizeArray(org.allowedMetadataTypes),
    restrictedMetadataTypes: normalizeArray(org.restrictedMetadataTypes)
  };
}

function requiredString(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`${label} is required in the Salesforce Org Registry.`);
  }
  return text;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function sameOrgId(left, right) {
  return normalizeOrgId(left) === normalizeOrgId(right);
}

function normalizeOrgId(value) {
  return String(value || '').trim().slice(0, 15).toUpperCase();
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}
