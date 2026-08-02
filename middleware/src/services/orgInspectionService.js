import { config } from '../config.js';
import { stableHash } from '../utils/hash.js';
import { assertTrustedOrgContext } from './orgContextTrust.js';
import { retrieveMetadata as retrieveSfMetadata, runSfCommand } from './sfExecutor.js';

const ALLOWED_METADATA_FAMILIES = new Set(['CustomObject', 'CustomField', 'Flow', 'ApexClass', 'ApexTrigger', 'ValidationRule', 'Layout', 'PermissionSet']);
const INSPECTION_QUERIES = [
  "SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN ('GiftTransaction','GiftCommitment')",
  "SELECT DeveloperName, Status FROM FlowDefinitionView WHERE ProcessType IN ('Flow','AutoLaunchedFlow','RecordTriggeredFlow')",
  "SELECT Name FROM ApexClass WHERE Name LIKE 'Gift%'",
  "SELECT ValidationName, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName IN ('GiftTransaction','GiftCommitment')",
  "SELECT Name, TableEnumOrId FROM Layout WHERE TableEnumOrId IN ('GiftTransaction','GiftCommitment')",
  'SELECT Name FROM PermissionSet WHERE IsOwnedByProfile = false'
];

export async function inspectFlowRequirement({ requirement, orgContext }, dependencies = {}) {
  assertInspectionOrgContext(orgContext);
  const sf = dependencies.sf || defaultSf(orgContext);
  const clock = dependencies.clock || (() => new Date());
  const maxComponents = Number(dependencies.maxComponents || config.maxRetrievedComponents);
  const maxDepth = Number(dependencies.maxDepth || config.maxDependencyDepth);
  const observedAt = clock().toISOString();
  const rows = [];

  try {
    for (const query of INSPECTION_QUERIES) {
      const result = await sf.query({ query, targetOrg: orgContext.salesforceAlias });
      if (result.exitCode !== 0) throw controlledInspectionError();
      rows.push(...parseRecords(result.stdout));
    }
  } catch (error) {
    if (error.code === 'ORG_INSPECTION_FAILED') throw error;
    throw controlledInspectionError();
  }

  const allowedRows = rows.map((row) => normalizeRecord(row, orgContext, observedAt))
    .filter((row) => row && isAllowedFamily(row, orgContext));
  validateMetadataComponents(allowedRows.map(componentFromRecord), { maxComponents: Number.MAX_SAFE_INTEGER, maxDepth: Number.MAX_SAFE_INTEGER, orgContext });
  const normalized = allowedRows.filter((row) => isRequirementRelevant(row, requirement));
  const components = validateMetadataComponents(normalized.map(componentFromRecord), { maxComponents, maxDepth, orgContext });
  const inspection = buildInspection(normalized, components, orgContext, observedAt, maxComponents, maxDepth);

  if (!inspection.objects.length || !inspection.relationships.length) {
    inspection.ambiguities.push({
      ambiguityId: 'material:flow-object-scope',
      material: true,
      question: 'Confirm which object represents the generated Donation and which relationship connects it to the Recurring Donation before planning source changes.'
    });
  } else if (components.length) {
    await sf.retrieveMetadata({ components, targetOrg: orgContext.salesforceAlias, orgContext });
  }

  return { ...inspection, hash: stableHash({ ...inspection, evidence: inspection.evidence.map((item) => ({ ...item, observedAt: '' })) }) };
}

export function validateMetadataComponents(components, options = {}) {
  const maxComponents = Number(options.maxComponents || config.maxRetrievedComponents);
  const maxDepth = Number(options.maxDepth || config.maxDependencyDepth);
  const orgContext = options.orgContext || {};
  const deduped = new Map();
  for (const component of components || []) {
    const type = String(component?.type || component?.metadataType || '').trim();
    const apiName = String(component?.apiName || '').trim();
    const dependencyLevel = Number(component?.dependencyLevel || 0);
    if (!type || !apiName || !isAllowedFamily({ type }, orgContext)) continue;
    validateComponentName(type, apiName);
    if (dependencyLevel > maxDepth) throw codedError('DEPENDENCY_DEPTH_LIMIT', `Metadata dependency depth exceeds the configured limit of ${maxDepth}.`);
    const key = `${type}:${apiName}`;
    if (!deduped.has(key)) deduped.set(key, { type, apiName, dependencyLevel });
  }
  const sorted = [...deduped.values()].sort(compareComponent);
  if (sorted.length > maxComponents) throw codedError('METADATA_SCOPE_LIMIT', `Metadata scope exceeds the configured limit of ${maxComponents} components.`);
  return sorted;
}

function defaultSf(orgContext) {
  return {
    query: ({ query }) => runSfCommand('dataQuery', { query }, { orgContext }),
    retrieveMetadata: ({ components }) => retrieveSfMetadata({ components, orgContext })
  };
}

function assertInspectionOrgContext(orgContext) {
  assertTrustedOrgContext(orgContext);
  if (!orgContext.verified?.organizationId || orgContext.verified.organizationId !== orgContext.expectedOrgId) {
    throw codedError('VERIFIED_ORG_CONTEXT_REQUIRED', 'A fresh verified Salesforce org context is required for org inspection.');
  }
  if (String(orgContext.environment || '').toLowerCase() === 'production' || orgContext.productionApprovalRequired === true) {
    throw codedError('PRODUCTION_ORG_BLOCKED', 'Production Salesforce orgs are not allowed in Phase 1.');
  }
}

function parseRecords(stdout) {
  const parsed = JSON.parse(stdout || '{}');
  return parsed.result?.records || parsed.records || [];
}

function normalizeRecord(row, orgContext, observedAt) {
  const type = row.metadataType || inferType(row);
  const apiName = row.apiName || row.QualifiedApiName || row.DeveloperName || row.Name || row.ValidationName;
  if (!type || !apiName) return null;
  return { ...row, type, apiName, objectApiName: row.objectApiName || row.EntityDefinition?.QualifiedApiName || objectFromApiName(apiName) || row.TableEnumOrId || '', dependencyLevel: Number(row.dependencyLevel || 0), sourceOrgId: orgContext.expectedOrgId, observedAt };
}

function inferType(row) {
  if (row.ValidationName) return 'ValidationRule';
  if (row.TableEnumOrId) return 'Layout';
  if (row.Status && row.DeveloperName) return 'Flow';
  if (row.DurableId || row.QualifiedApiName) return 'CustomObject';
  return '';
}

function isRequirementRelevant(row, requirement) {
  const text = [requirement?.summary, requirement?.businessRequirement, requirement?.acceptanceCriteria].join(' ');
  if (!/\b(donation|gift|recurring|installment|paid|completed)\b/i.test(text)) return false;
  return /\bGift|Donation|Recurring|Installment|Status|Paid|Completed/i.test([row.type, row.apiName, row.objectApiName, row.label, row.relationshipName, row.referenceTo].join(' '));
}

function isAllowedFamily(component, orgContext = {}) {
  const type = component.type;
  return ALLOWED_METADATA_FAMILIES.has(type) &&
    (!orgContext.allowedMetadataTypes?.length || orgContext.allowedMetadataTypes.includes(type)) &&
    !orgContext.restrictedMetadataTypes?.includes(type);
}

function componentFromRecord(row) {
  if (row.type === 'CustomField') return { type: 'CustomField', apiName: `${row.objectApiName}.${row.apiName}`, dependencyLevel: row.dependencyLevel };
  if (row.type === 'ValidationRule') return { type: 'ValidationRule', apiName: `${row.objectApiName}.${row.apiName}`, dependencyLevel: row.dependencyLevel };
  return { type: row.type, apiName: row.apiName, dependencyLevel: row.dependencyLevel };
}

function buildInspection(rows, components, orgContext, observedAt, maxComponents, maxDepth) {
  const componentKeys = new Set(components.map((item) => `${item.type}:${item.apiName}`));
  const objects = rows.filter((row) => row.type === 'CustomObject' && componentKeys.has(`CustomObject:${row.apiName}`)).map((row) => withEvidence(row, { apiName: row.apiName, label: row.label || row.apiName }));
  const fields = rows.filter((row) => row.type === 'CustomField' && componentKeys.has(`CustomField:${row.objectApiName}.${row.apiName}`)).map((row) => withEvidence(row, { objectApiName: row.objectApiName, apiName: row.apiName, label: row.label || row.apiName }));
  const relationships = rows.filter((row) => row.type === 'CustomField' && row.referenceTo).map((row) => withEvidence(row, { objectApiName: row.objectApiName, fieldApiName: row.apiName, relationshipName: row.relationshipName || '', referenceTo: row.referenceTo, evidenceId: `relationship:${row.objectApiName}.${row.apiName}` }));
  const statusCandidates = rows.filter((row) => row.type === 'CustomField' && /status/i.test(row.apiName)).map((row) => withEvidence(row, { objectApiName: row.objectApiName, fieldApiName: row.apiName, values: [...(row.values || [])].sort(), evidenceId: `statusCandidate:${row.objectApiName}.${row.apiName}` }));
  const flows = rows.filter((row) => row.type === 'Flow' && componentKeys.has(`Flow:${row.apiName}`)).map((row) => withEvidence(row, { apiName: row.apiName, label: row.label || row.apiName, status: row.status || row.Status || '', sourceOrgId: orgContext.expectedOrgId }));
  const apexAutomation = rows.filter((row) => ['ApexClass', 'ApexTrigger'].includes(row.type)).map((row) => withEvidence(row, { type: row.type, apiName: row.apiName, objectApiName: row.objectApiName || '' }));
  const validationRules = rows.filter((row) => row.type === 'ValidationRule').map((row) => withEvidence(row, { objectApiName: row.objectApiName, apiName: row.apiName }));
  const layouts = rows.filter((row) => row.type === 'Layout').map((row) => withEvidence(row, { objectApiName: row.objectApiName, apiName: row.apiName }));
  const permissionSets = rows.filter((row) => row.type === 'PermissionSet').map((row) => withEvidence(row, { apiName: row.apiName }));
  const evidence = [
    ...objects.map((item) => evidenceRecord('OBJECT', item, orgContext, observedAt)),
    ...fields.map((item) => evidenceRecord('FIELD', item, orgContext, observedAt)),
    ...relationships.map((item) => evidenceRecord('RELATIONSHIP', item, orgContext, observedAt)),
    ...statusCandidates.map((item) => evidenceRecord('STATUS_CANDIDATE', item, orgContext, observedAt)),
    ...flows.map((item) => evidenceRecord('FLOW', item, orgContext, observedAt)),
    ...apexAutomation.map((item) => evidenceRecord('APEX_AUTOMATION', item, orgContext, observedAt)),
    ...validationRules.map((item) => evidenceRecord('VALIDATION_RULE', item, orgContext, observedAt)),
    ...layouts.map((item) => evidenceRecord('LAYOUT', item, orgContext, observedAt)),
    ...permissionSets.map((item) => evidenceRecord('PERMISSION_SET', item, orgContext, observedAt))
  ].sort(compareEvidence);
  const primaryMetadata = components.map((item) => ({ ...item, sourceOrgId: orgContext.expectedOrgId, retrievalStatus: 'retrieved', analysisStatus: 'inspected', relevanceReason: 'Verified by deterministic org inspection' }));
  return {
    objects: uniqueSorted(objects, 'apiName'),
    fields: uniqueSorted(fields, (item) => `${item.objectApiName}.${item.apiName}`),
    relationships: uniqueSorted(relationships, (item) => `${item.objectApiName}.${item.fieldApiName}`),
    statusCandidates: uniqueSorted(statusCandidates, (item) => `${item.objectApiName}.${item.fieldApiName}`),
    flows: uniqueSorted(flows, 'apiName'),
    apexAutomation: uniqueSorted(apexAutomation, (item) => `${item.type}:${item.apiName}`),
    validationRules: uniqueSorted(validationRules, (item) => `${item.objectApiName}.${item.apiName}`),
    layouts: uniqueSorted(layouts, 'apiName'),
    permissionSets: uniqueSorted(permissionSets, 'apiName'),
    evidence,
    ambiguities: [],
    componentKeys: components,
    primaryMetadata,
    relatedMetadata: [],
    dependencies: [],
    excludedMetadata: ['Unrelated metadata', 'Restricted metadata types', 'Metadata outside the verified org', 'Metadata beyond bounded dependency depth'],
    maximumDependencyDepth: maxDepth,
    maximumComponents: maxComponents,
    hash: stableHash({ primaryMetadata, dependencies: [], maxComponents, maxDepth })
  };
}

function withEvidence(row, fields) {
  return { ...fields, sourceOrgId: row.sourceOrgId, evidenceId: fields.evidenceId || evidenceId(row.type, fields) };
}

function evidenceRecord(kind, item, orgContext, observedAt) {
  return { evidenceId: item.evidenceId, kind, objectApiName: item.objectApiName, fieldApiName: item.fieldApiName || item.apiName, componentType: item.type, componentApiName: item.apiName, sourceOrgId: orgContext.expectedOrgId, observedAt };
}

function evidenceId(type, item) {
  if (type === 'CustomField') return `field:${item.objectApiName}.${item.apiName}`;
  if (type === 'ValidationRule') return `validationRule:${item.objectApiName}.${item.apiName}`;
  if (item.fieldApiName) return `relationship:${item.objectApiName}.${item.fieldApiName}`;
  return `${type}:${item.apiName}`;
}

function validateComponentName(type, apiName) {
  const valid = type === 'CustomField' || type === 'ValidationRule'
    ? /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*(__c|Id)?$/.test(apiName)
    : type === 'Layout'
      ? /^[A-Za-z][A-Za-z0-9_]*(?:__c)?-[A-Za-z0-9_ ()/-]+$/.test(apiName)
      : /^[A-Za-z][A-Za-z0-9_]*(?:__c)?$/.test(apiName);
  if (!valid || /(?:;|&&|\|\||`|\$|<|>|\r|\n|--target-org|--metadata|\.\.)/i.test(apiName)) throw codedError('INVALID_METADATA_COMPONENT', 'Invalid Salesforce metadata component name.');
}

function objectFromApiName(apiName) {
  return String(apiName || '').includes('.') ? String(apiName).split('.')[0] : '';
}

function uniqueSorted(items, key) {
  const keyFn = typeof key === 'function' ? key : (item) => item[key];
  return [...new Map(items.map((item) => [keyFn(item), item])).values()].sort((left, right) => String(keyFn(left)).localeCompare(String(keyFn(right))));
}

function compareComponent(left, right) {
  return `${left.type}:${left.apiName}`.localeCompare(`${right.type}:${right.apiName}`);
}

function compareEvidence(left, right) {
  return left.evidenceId.localeCompare(right.evidenceId) || left.kind.localeCompare(right.kind);
}

function controlledInspectionError() {
  return codedError('ORG_INSPECTION_FAILED', 'Salesforce org inspection failed. Check the verified org connection and retry.');
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
