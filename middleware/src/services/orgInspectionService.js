import { config } from '../config.js';
import { canonicalInspectionHash } from '../domain/inspection.js';
import { stableHash } from '../utils/hash.js';
import { assertTrustedOrgContext } from './orgContextTrust.js';
import { retrieveMetadata as retrieveSfMetadata, runSfCommand, verifySelectedOrg } from './sfExecutor.js';

const ALLOWED_METADATA_FAMILIES = new Set(['CustomObject', 'CustomField', 'Flow', 'ApexClass', 'ApexTrigger', 'ValidationRule', 'Layout', 'PermissionSet']);
const DEFAULT_MAX_OBJECTS = 4;
const DEFAULT_MAX_FIELDS_PER_OBJECT = 50;
const DEFAULT_MAX_VERIFICATION_AGE_MS = 10 * 60 * 1000;
const DONATION_OBJECT_CANDIDATES = ['GiftCommitment', 'GiftTransaction'];
const RETRIEVE_RESULT_SUCCESS_STATUSES = new Set(['Succeeded']);
const RETRIEVE_FILE_SUCCESS_STATES = new Set(['Changed', 'Created', 'Deleted', 'Unchanged']);

export async function inspectFlowRequirement({ requirement, orgContext }, dependencies = {}) {
  const clock = dependencies.clock || (() => new Date());
  assertInspectionOrgContext(orgContext, clock, dependencies.maxVerificationAgeMs ?? config.maxOrgVerificationAgeMs ?? DEFAULT_MAX_VERIFICATION_AGE_MS);
  const sf = dependencies.sf || defaultSf(orgContext);
  const limits = {
    maxComponents: Number(dependencies.maxComponents ?? config.maxRetrievedComponents),
    maxDepth: Number(dependencies.maxDepth ?? config.maxDependencyDepth),
    maxObjects: Number(dependencies.maxObjects ?? DEFAULT_MAX_OBJECTS),
    maxFieldsPerObject: Number(dependencies.maxFieldsPerObject ?? DEFAULT_MAX_FIELDS_PER_OBJECT)
  };
  const observedAt = clock().toISOString();
  const state = inspectionState(orgContext, observedAt, limits);

  try {
    const objectRows = await runQueryOperation(sf, objectCandidateOperation(Math.min(limits.maxObjects, state.budgetRemaining)), orgContext);
    const objectCandidates = objectRows.map((row) => parseObjectCandidate(row, orgContext, observedAt));
    spendComponents(state, objectCandidates);

    await discoverFields(state, sf, orgContext, observedAt, requirement);

    for (const operationFactory of [flowOperation, apexClassOperation, apexTriggerOperation, validationRuleOperation, layoutOperation, permissionSetOperation]) {
      if (state.budgetRemaining <= 0) break;
      const operation = operationFactory(state);
      const rows = await runQueryOperation(sf, operation, orgContext);
      spendComponents(state, rows.map((row) => operation.parser(row, orgContext, observedAt)));
    }

    finalizeInspection(state);
    if (state.componentKeys.length && !state.ambiguities.some((item) => item.material)) {
      await retrieveAndMark(state, sf, orgContext);
    }
    return toInspection(state);
  } catch (error) {
    if (error.code) throw error;
    throw controlledInspectionError('Salesforce org inspection failed. Check the verified org connection and retry.');
  }
}

export function validateMetadataComponents(components, options = {}) {
  const maxComponents = Number(options.maxComponents ?? config.maxRetrievedComponents);
  const maxDepth = Number(options.maxDepth ?? config.maxDependencyDepth);
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
    query: ({ query, useToolingApi }) => runSfCommand(useToolingApi ? 'toolingQuery' : 'dataQuery', { query }, { orgContext }),
    verifyOrg: () => verifySelectedOrg(orgContext),
    retrieveMetadata: ({ components }) => retrieveSfMetadata({ components, orgContext })
  };
}

function inspectionState(orgContext, observedAt, limits) {
  return {
    orgContext,
    observedAt,
    limits,
    budgetRemaining: limits.maxComponents,
    components: new Map(),
    objects: [],
    fields: [],
    relationships: [],
    statusCandidates: [],
    flows: [],
    apexAutomation: [],
    validationRules: [],
    layouts: [],
    permissionSets: [],
    evidence: [],
    statusValueEvidence: [],
    ambiguities: []
  };
}

function objectCandidateOperation(limit) {
  return queryDescriptor('object-candidates', 'EntityDefinition.records', 'CustomObject', limit,
    `SELECT DurableId, QualifiedApiName, Label FROM EntityDefinition WHERE QualifiedApiName IN ('${DONATION_OBJECT_CANDIDATES.join("','")}') LIMIT ${limit}`,
    parseObjectCandidate,
    true);
}

function flowOperation(state) {
  const limit = Math.max(0, state.budgetRemaining);
  return queryDescriptor('flow-discovery', 'FlowDefinitionView.records', 'Flow', limit,
    `SELECT ApiName, Label, IsActive, ActiveVersion.VersionNumber, TriggerObjectOrEventLabel FROM FlowDefinitionView WHERE ApiName LIKE '%Gift%' LIMIT ${limit}`,
    (row, orgContext, observedAt) => rowFor('Flow', row.ApiName, orgContext, observedAt, 1, { label: row.Label || row.ApiName, status: row.IsActive ? 'Active' : 'Inactive', active: row.IsActive === true, activeVersionNumber: row.ActiveVersion?.VersionNumber || null, objectApiName: objectApiNameFromLabel(row.TriggerObjectOrEventLabel) }),
    true);
}

function apexClassOperation(state) {
  const limit = Math.max(0, state.budgetRemaining);
  return queryDescriptor('apex-class-discovery', 'ApexClass.records', 'ApexClass', limit,
    `SELECT Name FROM ApexClass WHERE Name LIKE '%Gift%' LIMIT ${limit}`,
    (row, orgContext, observedAt) => rowFor('ApexClass', row.Name, orgContext, observedAt, 1),
    true);
}

function apexTriggerOperation(state) {
  const limit = Math.max(0, state.budgetRemaining);
  return queryDescriptor('apex-trigger-discovery', 'ApexTrigger.records', 'ApexTrigger', limit,
    `SELECT Name, TableEnumOrId FROM ApexTrigger WHERE TableEnumOrId IN (${quotedObjects(state)}) LIMIT ${limit}`,
    (row, orgContext, observedAt) => rowFor('ApexTrigger', row.Name, orgContext, observedAt, 1, { objectApiName: row.TableEnumOrId || '' }),
    true);
}

function validationRuleOperation(state) {
  const limit = Math.max(0, state.budgetRemaining);
  return queryDescriptor('validation-rule-discovery', 'ValidationRule.records', 'ValidationRule', limit,
    `SELECT ValidationName, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName IN (${quotedObjects(state)}) LIMIT ${limit}`,
    (row, orgContext, observedAt) => rowFor('ValidationRule', row.ValidationName, orgContext, observedAt, 1, { objectApiName: row.EntityDefinition?.QualifiedApiName || '' }),
    true);
}

function layoutOperation(state) {
  const limit = Math.max(0, state.budgetRemaining);
  return queryDescriptor('layout-discovery', 'Layout.records', 'Layout', limit,
    `SELECT Name, TableEnumOrId FROM Layout WHERE TableEnumOrId IN (${quotedObjects(state)}) LIMIT ${limit}`,
    (row, orgContext, observedAt) => rowFor('Layout', row.Name, orgContext, observedAt, 1, { objectApiName: row.TableEnumOrId || '' }),
    true);
}

function permissionSetOperation(state) {
  const limit = Math.max(0, state.budgetRemaining);
  return queryDescriptor('permission-set-discovery', 'PermissionSet.records', 'PermissionSet', limit,
    `SELECT Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND Name LIKE '%Gift%' LIMIT ${limit}`,
    (row, orgContext, observedAt) => rowFor('PermissionSet', row.Name, orgContext, observedAt, 1, { label: row.Label || row.Name }),
    true);
}

function fieldDefinitionExactOperation(objectApiName, fieldApiName) {
  return queryDescriptor(`field-definition-exact:${objectApiName}.${fieldApiName}`, 'FieldDefinition.records', 'CustomField', 1,
    `SELECT EntityDefinition.QualifiedApiName, QualifiedApiName, Label, DataType, RelationshipName, ReferenceTo FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectApiName}' AND QualifiedApiName = '${fieldApiName}' LIMIT 1`,
    (row, orgContext, observedAt) => parseFieldDefinition(row, objectApiName, orgContext, observedAt),
    true);
}

function picklistValuesOperation(objectApiName, fieldApiName, limit) {
  return queryDescriptor(`picklist-values:${objectApiName}.${fieldApiName}`, 'PicklistValueInfo.records', 'PicklistValueInfo', limit,
    `SELECT EntityParticle.EntityDefinition.QualifiedApiName, EntityParticle.QualifiedApiName, Value, Label, IsActive FROM PicklistValueInfo WHERE EntityParticle.EntityDefinition.QualifiedApiName = '${objectApiName}' AND EntityParticle.QualifiedApiName = '${fieldApiName}' LIMIT ${limit}`,
    parsePicklistValue,
    true);
}

function queryDescriptor(operationId, resultKind, metadataType, limit, query, parser, useToolingApi = false) {
  return { operationId, kind: 'query', resultKind, metadataType, limit, query, parser, useToolingApi };
}

async function runQueryOperation(sf, operation, orgContext) {
  validateOperationLimit(operation);
  const result = await sf.query({ operationId: operation.operationId, resultKind: operation.resultKind, metadataType: operation.metadataType, query: operation.query, limit: operation.limit, useToolingApi: operation.useToolingApi, targetOrg: orgContext.salesforceAlias });
  if (result.exitCode !== 0) throw controlledInspectionError('Salesforce org inspection failed. Check the verified org connection and retry.');
  const records = parseQueryRecords(result.stdout, operation);
  if (records.length > operation.limit) throw codedError('ORG_INSPECTION_LIMIT_EXCEEDED', `Salesforce returned more ${operation.operationId} rows than the declared limit.`);
  return records;
}

async function discoverFields(state, sf, orgContext, observedAt, requirement) {
  const candidates = fieldCandidates(state, requirement);
  for (const candidate of candidates) {
    if (state.budgetRemaining <= 0) break;
    const operation = fieldDefinitionExactOperation(candidate.objectApiName, candidate.fieldApiName);
    const rows = await runQueryOperation(sf, operation, orgContext);
    spendComponents(state, rows.map((row) => operation.parser(row, orgContext, observedAt)));
  }

  for (const statusField of state.fields.filter((field) => /status/i.test(field.apiName))) {
    const operation = picklistValuesOperation(statusField.objectApiName, statusField.apiName, Math.min(state.limits.maxFieldsPerObject, 4));
    const rows = await runQueryOperation(sf, operation, orgContext);
    const values = rows.map((row) => operation.parser(row, orgContext, observedAt));
    applyPicklistValues(state, statusField, values, operation.operationId);
  }
}

function parseQueryRecords(stdout, operation) {
  const parsed = parseJson(stdout, 'ORG_INSPECTION_RESULT_SHAPE');
  const records = parsed.result?.records || parsed.records;
  if (!Array.isArray(records)) throw codedError('ORG_INSPECTION_RESULT_SHAPE', `${operation.operationId} did not return Salesforce query records.`);
  return records;
}

function parseObjectCandidate(row, orgContext, observedAt) {
  const unexpectedFieldShape = row.DataType || String(row.DurableId || '').includes('.') || String(row.QualifiedApiName || '').includes('.');
  if (unexpectedFieldShape) throw codedError('ORG_INSPECTION_RESULT_SHAPE', 'EntityDefinition discovery returned a field-shaped row.');
  return rowFor('CustomObject', row.QualifiedApiName, orgContext, observedAt, 0, { label: row.Label || row.QualifiedApiName });
}

function parseFieldDefinition(row, objectApiName, orgContext, observedAt) {
  const sourceObject = row.EntityDefinition?.QualifiedApiName || objectApiName;
  return rowFor('CustomField', row.QualifiedApiName, orgContext, observedAt, Number(row.dependencyLevel ?? 1), {
    objectApiName: sourceObject,
    label: row.Label || row.QualifiedApiName,
    dataType: row.DataType || '',
    referenceTo: referenceTarget(row.ReferenceTo),
    relationshipName: row.RelationshipName || '',
    values: []
  });
}

function parsePicklistValue(row) {
  const objectApiName = row.EntityParticle?.EntityDefinition?.QualifiedApiName;
  const fieldApiName = row.EntityParticle?.QualifiedApiName;
  const value = row.Value;
  if (!objectApiName || !fieldApiName || !value || typeof row.IsActive !== 'boolean') throw codedError('ORG_INSPECTION_RESULT_SHAPE', 'PicklistValueInfo row is missing required value evidence.');
  return { objectApiName, fieldApiName, value, label: row.Label || value, active: row.IsActive };
}

function fieldCandidates(state, requirement) {
  const requirementText = [requirement?.summary, requirement?.businessRequirement, ...(requirement?.acceptanceCriteria || [])].join(' ');
  const wantsStatus = /\b(status|paid|completed)\b/i.test(requirementText);
  const candidates = [];
  const objects = state.objects.map((item) => item.apiName);
  for (const sourceObject of objects) {
    for (const targetObject of objects) {
      if (sourceObject === targetObject) continue;
      candidates.push({ objectApiName: sourceObject, fieldApiName: `${targetObject}Id` });
      candidates.push({ objectApiName: sourceObject, fieldApiName: `${targetObject}__c` });
    }
    if (wantsStatus) candidates.push({ objectApiName: sourceObject, fieldApiName: 'Status' });
  }
  return uniqueSorted(candidates, (item) => `${item.objectApiName}.${item.fieldApiName}`)
    .slice(0, state.limits.maxObjects * 3);
}

function applyPicklistValues(state, statusField, values, operationId) {
  const activeValues = uniqueSorted(
    values.filter((item) => item.active && item.objectApiName === statusField.objectApiName && item.fieldApiName === statusField.apiName),
    'value'
  );
  const candidate = state.statusCandidates.find((item) => item.objectApiName === statusField.objectApiName && item.fieldApiName === statusField.apiName);
  if (candidate) candidate.values = activeValues.map((item) => item.value).sort();
  for (const item of activeValues) {
    state.statusValueEvidence.push({
      evidenceId: `statusValue:${item.objectApiName}.${item.fieldApiName}.${item.value}`,
      kind: 'STATUS_VALUE',
      objectApiName: item.objectApiName,
      fieldApiName: item.fieldApiName,
      value: item.value,
      label: item.label,
      operationId,
    sourceOrgId: state.orgContext.expectedOrgId,
    active: true,
    observedAt: state.observedAt
    });
  }
}

function spendComponents(state, rows) {
  for (const row of rows.filter((item) => isAllowedFamily(item, state.orgContext) && isRelevant(item))) {
    const component = componentFromRow(row);
    validateMetadataComponents([component], { maxComponents: 1, maxDepth: state.limits.maxDepth, orgContext: state.orgContext });
    const key = `${component.type}:${component.apiName}`;
    if (!state.components.has(key)) {
      if (state.budgetRemaining <= 0) break;
      state.components.set(key, { ...component, sourceOrgId: state.orgContext.expectedOrgId, retrievalStatus: 'pending', analysisStatus: 'inspected', relevanceReason: 'Verified by deterministic org inspection' });
      state.budgetRemaining -= 1;
    }
    appendRow(state, row);
  }
}

function appendRow(state, row) {
  if (row.type === 'CustomObject') state.objects.push(withEvidence(row, { apiName: row.apiName, label: row.label || row.apiName }));
  if (row.type === 'CustomField') {
    state.fields.push(withEvidence(row, { objectApiName: row.objectApiName, apiName: row.apiName, label: row.label || row.apiName, dataType: row.dataType || '' }));
    if (row.referenceTo) state.relationships.push(withEvidence(row, { objectApiName: row.objectApiName, fieldApiName: row.apiName, referenceTo: row.referenceTo, relationshipName: row.relationshipName || '', evidenceId: `relationship:${row.objectApiName}.${row.apiName}` }));
    if (/status/i.test(row.apiName)) state.statusCandidates.push(withEvidence(row, { objectApiName: row.objectApiName, fieldApiName: row.apiName, values: [...(row.values || [])].sort(), evidenceId: `statusCandidate:${row.objectApiName}.${row.apiName}` }));
  }
  if (row.type === 'Flow') state.flows.push(withEvidence(row, { apiName: row.apiName, label: row.label || row.apiName, status: row.status || '', sourceOrgId: state.orgContext.expectedOrgId }));
  if (['ApexClass', 'ApexTrigger'].includes(row.type)) state.apexAutomation.push(withEvidence(row, { type: row.type, apiName: row.apiName, objectApiName: row.objectApiName || '' }));
  if (row.type === 'ValidationRule') state.validationRules.push(withEvidence(row, { objectApiName: row.objectApiName, apiName: row.apiName }));
  if (row.type === 'Layout') state.layouts.push(withEvidence(row, { objectApiName: row.objectApiName, apiName: row.apiName }));
  if (row.type === 'PermissionSet') state.permissionSets.push(withEvidence(row, { apiName: row.apiName, label: row.label || row.apiName }));
}

function finalizeInspection(state) {
  state.objects = uniqueSorted(state.objects, 'apiName');
  state.fields = uniqueSorted(state.fields, (item) => `${item.objectApiName}.${item.apiName}`);
  state.relationships = uniqueSorted(state.relationships, (item) => `${item.objectApiName}.${item.fieldApiName}`);
  state.statusCandidates = uniqueSorted(state.statusCandidates, (item) => `${item.objectApiName}.${item.fieldApiName}`);
  state.flows = uniqueSorted(state.flows, 'apiName');
  state.apexAutomation = uniqueSorted(state.apexAutomation, (item) => `${item.type}:${item.apiName}`);
  state.validationRules = uniqueSorted(state.validationRules, (item) => `${item.objectApiName}.${item.apiName}`);
  state.layouts = uniqueSorted(state.layouts, 'apiName');
  state.permissionSets = uniqueSorted(state.permissionSets, 'apiName');
  state.componentKeys = [...state.components.values()].sort(compareComponent);
  state.evidence = buildEvidence(state).sort(compareEvidence);
  if (!hasConnectedRelationship(state)) {
    state.ambiguities.push({
      ambiguityId: 'material:flow-object-relationship',
      material: true,
      question: 'Confirm which verified Donation object relationship connects to the verified Recurring Donation object before planning source changes.'
    });
  }
  if (!hasRequiredStatusValues(state)) {
    state.ambiguities.push({
      ambiguityId: 'material:status-values',
      material: true,
      question: 'Confirm the verified Donation status values that represent paid or completed donations before planning source changes.'
    });
  }
}

async function retrieveAndMark(state, sf, orgContext) {
  if (sf.verifyOrg) await sf.verifyOrg(orgContext);
  const result = await sf.retrieveMetadata({ components: state.componentKeys, targetOrg: orgContext.salesforceAlias, orgContext });
  const parsed = parseJson(result.stdout, 'ORG_INSPECTION_RETRIEVAL_FAILED');
  const evidence = normalizeRetrieveEvidence(parsed, result.exitCode);
  const requestedComponentKeys = new Set(state.componentKeys.map((component) => `${component.type}:${component.apiName}`));
  if (!setsEqual(evidence.componentKeys, requestedComponentKeys)) throw retrievalError();
  for (const component of state.components.values()) component.retrievalStatus = 'retrieved';
}

function toInspection(state) {
  const primaryMetadata = [...state.components.values()].sort(compareComponent);
  const inspection = {
    sourceOrgId: state.orgContext.expectedOrgId,
    objects: state.objects,
    fields: state.fields,
    relationships: state.relationships,
    statusCandidates: state.statusCandidates,
    flows: state.flows,
    apexAutomation: state.apexAutomation,
    validationRules: state.validationRules,
    layouts: state.layouts,
    permissionSets: state.permissionSets,
    evidence: state.evidence,
    ambiguities: state.ambiguities,
    componentKeys: primaryMetadata.map(({ type, apiName, dependencyLevel }) => ({ type, apiName, dependencyLevel })),
    primaryMetadata,
    relatedMetadata: [],
    dependencies: [],
    excludedMetadata: ['Unrelated metadata', 'Restricted metadata types', 'Metadata outside the verified org', 'Metadata beyond bounded dependency depth'],
    maximumDependencyDepth: state.limits.maxDepth,
    maximumComponents: state.limits.maxComponents
  };
  return { ...inspection, hash: canonicalInspectionHash(inspection) };
}

function buildEvidence(state) {
  return [
    ...state.objects.map((item) => evidenceRecord('OBJECT', item, state)),
    ...state.fields.map((item) => evidenceRecord('FIELD', item, state)),
    ...state.relationships.map((item) => evidenceRecord('RELATIONSHIP', item, state)),
    ...state.statusCandidates.map((item) => evidenceRecord('STATUS_CANDIDATE', item, state)),
    ...state.statusValueEvidence,
    ...state.flows.map((item) => evidenceRecord('FLOW', item, state)),
    ...state.apexAutomation.map((item) => evidenceRecord('APEX_AUTOMATION', item, state)),
    ...state.validationRules.map((item) => evidenceRecord('VALIDATION_RULE', item, state)),
    ...state.layouts.map((item) => evidenceRecord('LAYOUT', item, state)),
    ...state.permissionSets.map((item) => evidenceRecord('PERMISSION_SET', item, state))
  ];
}

function evidenceRecord(kind, item, state) {
  return { evidenceId: item.evidenceId, kind, objectApiName: item.objectApiName, fieldApiName: item.fieldApiName || item.apiName, targetObjectApiName: item.referenceTo, componentType: item.type || metadataTypeForEvidence(kind), componentApiName: componentApiNameForEvidence(kind, item), sourceOrgId: state.orgContext.expectedOrgId, active: true, observedAt: state.observedAt };
}

function metadataTypeForEvidence(kind) {
  return {
    OBJECT: 'CustomObject',
    FIELD: 'CustomField',
    RELATIONSHIP: 'CustomField',
    STATUS_CANDIDATE: 'CustomField',
    STATUS_VALUE: 'CustomField',
    FLOW: 'Flow',
    APEX_AUTOMATION: 'ApexClass',
    VALIDATION_RULE: 'ValidationRule',
    LAYOUT: 'Layout',
    PERMISSION_SET: 'PermissionSet'
  }[kind] || '';
}

function componentApiNameForEvidence(kind, item) {
  if (['FIELD', 'RELATIONSHIP', 'STATUS_CANDIDATE', 'STATUS_VALUE'].includes(kind)) return `${item.objectApiName}.${item.fieldApiName || item.apiName}`;
  if (kind === 'VALIDATION_RULE') return `${item.objectApiName}.${item.apiName}`;
  return item.apiName || '';
}

function hasConnectedRelationship(state) {
  const objects = new Set(state.objects.map((item) => item.apiName));
  return state.relationships.some((item) => objects.has(item.objectApiName) && objects.has(item.referenceTo));
}

function hasRequiredStatusValues(state) {
  return state.statusCandidates.some((item) => {
    const values = new Set((item.values || []).map((value) => String(value).toLowerCase()));
    return values.has('paid') && values.has('completed');
  });
}

function isRelevant(row) {
  if (row.type === 'CustomObject') return DONATION_OBJECT_CANDIDATES.includes(row.apiName);
  if (row.type === 'CustomField') return DONATION_OBJECT_CANDIDATES.includes(row.objectApiName) && (!row.referenceTo || DONATION_OBJECT_CANDIDATES.includes(row.referenceTo) || /status/i.test(row.apiName));
  if (row.objectApiName) return DONATION_OBJECT_CANDIDATES.includes(row.objectApiName);
  return /\bGift|Donation|Recurring|Installment|Status|Paid|Completed/i.test([row.apiName, row.label].join(' '));
}

function componentFromRow(row) {
  if (row.type === 'CustomField') return { type: 'CustomField', apiName: `${row.objectApiName}.${row.apiName}`, dependencyLevel: row.dependencyLevel };
  if (row.type === 'ValidationRule') return { type: 'ValidationRule', apiName: `${row.objectApiName}.${row.apiName}`, dependencyLevel: row.dependencyLevel };
  return { type: row.type, apiName: row.apiName, dependencyLevel: row.dependencyLevel };
}

function rowFor(type, apiName, orgContext, observedAt, dependencyLevel, extra = {}) {
  if (!apiName) throw codedError('ORG_INSPECTION_RESULT_SHAPE', `${type} discovery row is missing its API name.`);
  return { type, apiName, dependencyLevel, sourceOrgId: orgContext.expectedOrgId, observedAt, ...extra };
}

function withEvidence(row, fields) {
  return { ...fields, sourceOrgId: row.sourceOrgId, evidenceId: fields.evidenceId || evidenceId(row.type, fields) };
}

function evidenceId(type, item) {
  if (type === 'CustomField') return `field:${item.objectApiName}.${item.apiName}`;
  if (type === 'ValidationRule') return `validationRule:${item.objectApiName}.${item.apiName}`;
  return `${type}:${item.apiName}`;
}

function assertInspectionOrgContext(orgContext, clock, maxAgeMs) {
  assertTrustedOrgContext(orgContext);
  if (!orgContext.verified?.organizationId || orgContext.verified.organizationId !== orgContext.expectedOrgId) throw codedError('VERIFIED_ORG_CONTEXT_REQUIRED', 'A fresh verified Salesforce org context is required for org inspection.');
  const verifiedAt = Date.parse(orgContext.verified.verifiedAt || '');
  const now = clock().getTime();
  if (!Number.isFinite(verifiedAt) || verifiedAt > now + 30000 || now - verifiedAt > maxAgeMs) throw codedError('VERIFIED_ORG_CONTEXT_STALE', 'Salesforce org verification is missing, invalid, future-dated, or expired.');
  if (String(orgContext.environment || '').toLowerCase() === 'production' || orgContext.productionApprovalRequired === true) throw codedError('PRODUCTION_ORG_BLOCKED', 'Production Salesforce orgs are not allowed in Phase 1.');
}

function validateOperationLimit(operation) {
  if (!Number.isInteger(operation.limit) || operation.limit < 0) throw codedError('ORG_INSPECTION_LIMIT_REQUIRED', `${operation.operationId} requires a numeric LIMIT.`);
  if (!new RegExp(`\\bLIMIT\\s+${operation.limit}\\b`, 'i').test(operation.query)) throw codedError('ORG_INSPECTION_LIMIT_REQUIRED', `${operation.operationId} query must include its declared LIMIT.`);
}

function validateComponentName(type, apiName) {
  const valid = type === 'CustomField' || type === 'ValidationRule'
    ? /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*(__c|Id)?$/.test(apiName)
    : type === 'Layout'
      ? /^[A-Za-z][A-Za-z0-9_]*(?:__c)?-[A-Za-z0-9_ ()/-]+$/.test(apiName)
      : /^[A-Za-z][A-Za-z0-9_]*(?:__c)?$/.test(apiName);
  if (!valid || /(?:;|&&|\|\||`|\$|<|>|\r|\n|--target-org|--metadata|\.\.)/i.test(apiName)) throw codedError('INVALID_METADATA_COMPONENT', 'Invalid Salesforce metadata component name.');
}

function parseJson(stdout, code) {
  try {
    return JSON.parse(stdout || '{}');
  } catch {
    throw code === 'ORG_INSPECTION_RETRIEVAL_FAILED' ? retrievalError() : codedError(code, 'Salesforce CLI returned malformed JSON.');
  }
}

function normalizeRetrieveEvidence(parsed, exitCode) {
  const result = parsed.result || {};
  const success = exitCode === 0 && parsed.status === 0 && result.done === true && RETRIEVE_RESULT_SUCCESS_STATUSES.has(result.status);
  const files = Array.isArray(result.files) ? result.files : [];
  const compatibilityFileResponses = files.length === 0 && Array.isArray(result.fileResponses) ? result.fileResponses : [];
  const retrievedFiles = files.length > 0 ? files : compatibilityFileResponses;
  if (!success || !retrievedFiles.length) throw retrievalError();
  const componentKeys = new Set();
  const recordsByComponent = new Map();
  for (const file of retrievedFiles) {
    const record = normalizeRetrieveFileEvidence(file);
    const duplicate = recordsByComponent.get(record.componentKey);
    if (duplicate && stableHash(duplicate) !== stableHash(record)) throw retrievalError();
    recordsByComponent.set(record.componentKey, record);
    componentKeys.add(record.componentKey);
  }
  if (!componentKeys.size) throw retrievalError();
  return { componentKeys };
}

function normalizeRetrieveFileEvidence(file) {
  if (!file || typeof file !== 'object') throw retrievalError();
  const state = file.state ?? file.status;
  if (!RETRIEVE_FILE_SUCCESS_STATES.has(state)) throw retrievalError();
  const canonicalPath = canonicalRetrievePath(file.filePath ?? file.path);
  const claimedComponent = componentFromRetrieveClaim(file);
  if (!canonicalPath && !claimedComponent) throw retrievalError();
  const pathComponent = canonicalPath ? componentFromRetrievePath(canonicalPath) : null;
  if (canonicalPath && !pathComponent) throw retrievalError();
  if (pathComponent && claimedComponent && !sameComponent(pathComponent, claimedComponent)) throw retrievalError();
  const component = pathComponent || claimedComponent;
  validateRetrieveComponent(component);
  return {
    canonicalPath: canonicalPath || '',
    claimPresent: Boolean(claimedComponent),
    type: component.type,
    fullName: component.apiName,
    componentKey: `${component.type}:${component.apiName}`,
    state
  };
}

function canonicalRetrievePath(value) {
  if (value === undefined || value === null || value === '') return '';
  const raw = String(value);
  const normalized = raw.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//.test(normalized)) throw retrievalError();
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw retrievalError();
  if (segments[0] !== 'force-app' || segments[1] !== 'main' || segments[2] !== 'default') throw retrievalError();
  if (segments.length < 5) throw retrievalError();
  return segments.join('/');
}

function componentFromRetrieveClaim(file) {
  const hasType = Object.hasOwn(file, 'type');
  const hasFullName = Object.hasOwn(file, 'fullName');
  if (hasType !== hasFullName) throw retrievalError();
  if (!hasType && !hasFullName) return null;
  const component = { type: String(file.type), apiName: String(file.fullName) };
  validateRetrieveComponent(component);
  return component;
}

function validateRetrieveComponent(component) {
  if (!component || !isAllowedFamily(component)) throw retrievalError();
  try {
    validateComponentName(component.type, component.apiName);
  } catch {
    throw retrievalError();
  }
}

function componentFromRetrievePath(path) {
  let match = path.match(/^force-app\/main\/default\/classes\/([^/]+)\.cls$/);
  if (match) return { type: 'ApexClass', apiName: match[1] };
  match = path.match(/^force-app\/main\/default\/triggers\/([^/]+)\.trigger$/);
  if (match) return { type: 'ApexTrigger', apiName: match[1] };
  match = path.match(/^force-app\/main\/default\/objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/);
  if (match) return { type: 'CustomField', apiName: `${match[1]}.${match[2]}` };
  match = path.match(/^force-app\/main\/default\/objects\/([^/]+)\/\1\.object-meta\.xml$/);
  if (match) return { type: 'CustomObject', apiName: match[1] };
  match = path.match(/^force-app\/main\/default\/flows\/([^/]+)\.flow-meta\.xml$/);
  if (match) return { type: 'Flow', apiName: match[1] };
  match = path.match(/^force-app\/main\/default\/layouts\/([^/]+)\.layout-meta\.xml$/);
  if (match) return { type: 'Layout', apiName: match[1] };
  match = path.match(/^force-app\/main\/default\/permissionsets\/([^/]+)\.permissionset-meta\.xml$/);
  if (match) return { type: 'PermissionSet', apiName: match[1] };
  match = path.match(/^force-app\/main\/default\/objects\/([^/]+)\/validationRules\/([^/]+)\.validationRule-meta\.xml$/);
  if (match) return { type: 'ValidationRule', apiName: `${match[1]}.${match[2]}` };
  return null;
}

function sameComponent(left, right) {
  return left.type === right.type && left.apiName === right.apiName;
}

function quotedObjects(state) {
  return state.objects.map((item) => `'${item.apiName}'`).join(',');
}

function referenceTarget(value) {
  if (Array.isArray(value)) return value[0] || '';
  const text = String(value || '');
  if (!text) return '';
  return text.split(',').map((item) => item.trim()).find(Boolean) || '';
}

function objectApiNameFromLabel(label) {
  return DONATION_OBJECT_CANDIDATES.find((candidate) => label === candidate || label === candidate.replace(/([a-z])([A-Z])/g, '$1 $2')) || '';
}

function isAllowedFamily(component, orgContext = {}) {
  const type = component.type;
  return ALLOWED_METADATA_FAMILIES.has(type) && (!orgContext.allowedMetadataTypes?.length || orgContext.allowedMetadataTypes.includes(type)) && !orgContext.restrictedMetadataTypes?.includes(type);
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

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function controlledInspectionError(message) {
  return codedError('ORG_INSPECTION_FAILED', message);
}

function retrievalError() {
  return codedError('ORG_INSPECTION_RETRIEVAL_FAILED', 'Salesforce metadata retrieval failed for the verified component scope. Review the bounded inspection evidence and retry.');
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
