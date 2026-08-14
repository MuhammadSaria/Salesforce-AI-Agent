import { sameSalesforceId } from '../utils/salesforceId.js';
import { validateSpecialistEvidence } from '../domain/specialistEvidence.js';
import { parseMetadataXml } from '../specialists/metadataXml.js';
import { validateRecurringDonationFlowDocument } from '../specialists/flowSemantics.js';

export function validateFlowSource({ content, approvedBehavior, inspection }) {
  const behavior = approvedBehavior || {};
  assertInspectionBinding(behavior, inspection);
  const xml = parseMetadataXml(content, 'Flow');
  assertTopLevelFlowMetadata(xml);

  const evidence = selectedEvidence(inspection?.evidence, behavior.evidenceIds);
  const validatedEvidence = validateSpecialistEvidence(evidence, {
    sourceOrgId: behavior.sourceOrgId,
    specialistId: 'FLOW',
    approvedComponents: [{ metadataType: 'Flow', apiName: behavior.flowApiName }],
    dependencyResults: [{
      specialistId: 'OBJECT_FIELD',
      operations: [{ metadataType: 'CustomField', apiName: `${behavior.objectApiName}.${behavior.installmentField}` }]
    }],
    now: behavior.now
  });
  const relationships = validatedEvidence.filter((item) => item.kind === 'RELATIONSHIP' && item.objectApiName === behavior.objectApiName);
  const statuses = validatedEvidence.filter((item) => item.kind === 'STATUS_VALUE' && item.objectApiName === behavior.objectApiName);
  if (relationships.length !== 1 || statuses.length !== 1) throw evidenceError();

  return validateRecurringDonationFlowDocument(xml, {
    objectApiName: behavior.objectApiName,
    installmentField: behavior.installmentField,
    relationshipField: relationships[0].fieldApiName,
    statusField: statuses[0].fieldApiName,
    completedValue: statuses[0].value
  });
}

function assertTopLevelFlowMetadata(xml) {
  const labels = xml.children(xml.root, 'label');
  const versions = xml.children(xml.root, 'apiVersion');
  const processTypes = xml.children(xml.root, 'processType');
  const label = labels[0]?.text.trim() || '';
  const apiVersion = versions[0]?.text.trim() || '';
  const version = Number(apiVersion);
  if (labels.length !== 1 || !label || label.length > 255) throw flowError('Flow must contain one bounded label.');
  if (versions.length !== 1 || !/^\d{1,3}\.\d{1,2}$/.test(apiVersion) || !Number.isFinite(version) || version <= 0) throw flowError('Flow must contain one valid API version.');
  if (processTypes.length !== 1 || processTypes[0].text.trim() !== 'AutoLaunchedFlow') throw flowError('Flow must be an auto-launched record-triggered process.');
}

function assertInspectionBinding(behavior, inspection) {
  if (!behavior.sourceOrgId || !inspection?.sourceOrgId || !sameSalesforceId(behavior.sourceOrgId, inspection.sourceOrgId)) throw evidenceError();
}

function selectedEvidence(evidence, evidenceIds) {
  const required = new Set(evidenceIds || []);
  const selected = (evidence || [])
    .filter((item) => required.has(item.evidenceId))
    .map(strictFlowEvidence);
  if (required.size !== selected.length || new Set(selected.map((item) => item.evidenceId)).size !== selected.length) throw evidenceError();
  return selected;
}

function strictFlowEvidence(item) {
  const common = {
    evidenceId: item.evidenceId,
    kind: item.kind,
    sourceOrgId: item.sourceOrgId,
    active: item.active,
    stale: item.stale ?? false,
    observedAt: item.observedAt
  };
  if (item.kind === 'RELATIONSHIP') return { ...common, objectApiName: item.objectApiName, fieldApiName: item.fieldApiName, targetObjectApiName: item.targetObjectApiName, componentType: item.componentType, componentApiName: item.componentApiName };
  if (item.kind === 'STATUS_VALUE') return { ...common, objectApiName: item.objectApiName, fieldApiName: item.fieldApiName, value: item.value, componentType: item.componentType, componentApiName: item.componentApiName };
  if (item.kind === 'RETRIEVED_COMPONENT') return { ...common, componentType: item.componentType, componentApiName: item.componentApiName, retrievedSource: item.retrievedSource };
  return { ...item, stale: item.stale ?? false };
}

function evidenceError() {
  return Object.assign(new Error('Trusted Flow inspection evidence is missing or invalid.'), { code: 'SPECIALIST_EVIDENCE_INVALID', statusCode: 409 });
}

function flowError(message) {
  return Object.assign(new Error(message), { code: 'SPECIALIST_FLOW_INVALID', statusCode: 409 });
}
