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
  return selectOrgFromRegistry(registry.orgs, job);
}

export function selectOrgFromRegistry(orgs, job) {
  const activeOrgs = orgs.filter((org) => org.active && org.authenticationStatus === 'connected');
  const context = job.context || {};

  if (context.selectedOrgRegistryId) {
    const explicitlyAllowed = activeOrgs.filter((org) => org.id === context.selectedOrgRegistryId);
    return selectionResult(explicitlyAllowed, ['explicitUserSelection']);
  }

  if (job.orgId) {
    const exact = activeOrgs.filter((org) => sameOrgId(org.expectedOrgId, job.orgId));
    if (exact.length) return selectionResult(exact, ['authenticatedSalesforceOrgId']);
  }

  const signals = [];
  if (context.jiraProjectKey) {
    signals.push({
      source: 'jiraProjectKey',
      matches: activeOrgs.filter((org) => org.jiraProjectKeys.includes(String(context.jiraProjectKey).toUpperCase()))
    });
  }

  const components = normalizeArray(context.jiraComponents || context.jiraComponent);
  if (components.length) {
    const mappedComponentsExist = activeOrgs.some((org) => org.jiraComponents.length > 0);
    if (mappedComponentsExist) {
      signals.push({
        source: 'jiraComponent',
        matches: activeOrgs.filter((org) => org.jiraComponents.some((component) => components.some((value) => normalizeText(value) === normalizeText(component))))
      });
    }
  }

  const customFields = context.jiraCustomFields && typeof context.jiraCustomFields === 'object' ? context.jiraCustomFields : {};
  for (const [fieldId, ticketValue] of Object.entries(customFields)) {
    if (!normalizeText(ticketValue)) continue;
    const configured = activeOrgs.filter((org) => Object.hasOwn(org.jiraCustomFieldMappings, fieldId));
    if (!configured.length) continue;
    signals.push({
      source: `jiraCustomField:${fieldId}`,
      matches: configured.filter((org) => mappingMatches(org.jiraCustomFieldMappings[fieldId], ticketValue))
    });
  }

  // Customer/environment are accepted only from the authenticated API context, never ticket prose.
  if (context.customerName) {
    signals.push({ source: 'authenticatedCustomer', matches: activeOrgs.filter((org) => normalizeText(org.customerName) === normalizeText(context.customerName)) });
  }
  if (context.environment) {
    signals.push({ source: 'authenticatedEnvironment', matches: activeOrgs.filter((org) => org.environment === String(context.environment).toLowerCase()) });
  }

  if (context.repositoryPath) {
    const repositoryPath = resolve(String(context.repositoryPath));
    signals.push({ source: 'repositoryMapping', matches: activeOrgs.filter((org) => org.repositoryPaths.some((path) => repositoryPath.startsWith(resolve(config.projectRoot, path)))) });
  }

  if (!signals.length) return selectionResult([], [], activeOrgs);
  const candidates = signals.reduce(
    (current, signal) => current.filter((org) => signal.matches.some((match) => match.id === org.id)),
    activeOrgs
  );
  return selectionResult(candidates, signals.map((signal) => signal.source), activeOrgs);
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
    dataMutationPermission: selection.org.dataMutationPermission,
    allowedDataObjects: selection.org.allowedDataObjects,
    maximumDataOperations: selection.org.maximumDataOperations,
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
    dataMutationPermission: org.dataMutationPermission,
    productionApprovalRequired: org.productionApprovalRequired,
    authenticationStatus: org.authenticationStatus
  };
}

function selectionResult(candidates, sources = [], selectionOptions = []) {
  if (candidates.length === 1) {
    return {
      status: 'selected',
      org: candidates[0],
      source: sources.join('+'),
      evidence: sources
    };
  }

  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates: candidates.map(publicOrgOption),
      evidence: sources
    };
  }

  return { status: 'none', candidates: selectionOptions.map(publicOrgOption), evidence: sources };
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
    jiraCustomFieldMappings: normalizeCustomFieldMappings(org.jiraCustomFieldMappings),
    repositoryPaths: normalizeArray(org.repositoryPaths),
    localProjectPath: String(org.localProjectPath || ''),
    authenticationStatus: String(org.authenticationStatus || 'unknown'),
    deploymentPermission: String(org.deploymentPermission || 'blocked'),
    dataMutationPermission: String(org.dataMutationPermission || 'blocked'),
    allowedDataObjects: normalizeArray(org.allowedDataObjects),
    maximumDataOperations: Math.max(1, Math.min(Number(org.maximumDataOperations || 10), 25)),
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
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeCustomFieldMappings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([fieldId, expected]) => [fieldId, normalizeArray(expected)]));
}

function mappingMatches(expectedValues, ticketValue) {
  const actual = normalizeText(ticketValue);
  return normalizeArray(expectedValues).some((expected) => normalizeText(expected) === actual);
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
