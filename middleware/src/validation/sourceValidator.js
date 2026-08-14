import { config } from '../config.js';
import { assertCanonicalOperationPath } from '../domain/metadataPath.js';
import { SPECIALIST_OPERATION_SCHEMA } from '../domain/specialistContract.js';
import {
  assertSpecialistOwnsFile,
  ownerForMetadataType,
  specialistIdForArchitectureOwner
} from '../domain/specialistAgents.js';
import { parseMetadataXml, MAX_METADATA_XML_BYTES } from '../specialists/metadataXml.js';
import { stableHash } from '../utils/hash.js';
import { sameSalesforceId } from '../utils/salesforceId.js';
import { validateFlowSource } from './flowValidator.js';

const SECURITY_TYPES = new Set(['PermissionSet', 'PermissionSetGroup', 'MutingPermissionSet', 'Profile', 'CustomPermission']);
const FORBIDDEN_SECURITY_ELEMENTS = new Set([
  'applicationVisibilities', 'classAccesses', 'customPermissions', 'flowAccesses',
  'objectPermissions', 'recordTypeVisibilities', 'tabSettings', 'userPermissions'
]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*["']?[^\s<"']{8,}/i,
  /<(?:refreshToken|clientSecret|password)>[^<]{8,}<\//i,
  /\bDATABASE_URL\s*=\s*(?:postgres(?:ql)?|mysql|mssql):\/\//i
];
const SCRIPT_PATTERNS = [
  /#!\/(?:usr\/bin\/env\s+)?(?:ba|z|k)?sh\b/i,
  /\bcmd\.exe\b/i,
  /\bpowershell(?:\.exe)?\b(?:\s+-|\s)/i,
  /\b(?:node:)?child_process\b/i,
  /\brequire\s*\(\s*["'](?:node:)?child_process["']\s*\)/i
];

export function validateSpecialistOperations({ operations, plan, ownership, inspection }) {
  if (!Array.isArray(operations) || !plan || !ownership || !inspection) throw sourceError('SPECIALIST_SOURCE_INVALID', 'Specialist source validation input is incomplete.');
  assertTrustedInspection(plan, inspection);
  const approved = approvedComponents(plan);
  const totalBytes = operations.reduce((total, operation) => total + Buffer.byteLength(String(operation?.content || ''), 'utf8'), 0);
  if (totalBytes > config.maxMetadataSizeBytes) throw sourceError('SPECIALIST_SOURCE_TOO_LARGE', 'Specialist source exceeds the configured aggregate size limit.');
  const seenPaths = new Set();
  const seenComponents = new Set();
  const validated = [];
  for (const rawOperation of operations) {
    assertDocumentSize(rawOperation?.content);
    const operation = parseOperation(rawOperation);
    assertCanonicalOperationPath(operation);
    assertUniqueIdentity(operation, seenPaths, seenComponents);
    const key = componentKey(operation);
    const component = approved.get(key);
    if (!component) throw sourceError('SPECIALIST_SCOPE_VIOLATION', 'Specialist source contains an unapproved metadata component.');
    assertOwnership(operation, component, ownership);
    assertNoSecretOrScript(operation.content);
    validateMetadataSource(operation, operations, plan, inspection);
    validated.push({ ...operation });
  }
  if (validated.length !== approved.size || [...approved.keys()].some((key) => !seenComponents.has(key.toLocaleLowerCase('en-US')))) {
    throw sourceError('SPECIALIST_SCOPE_VIOLATION', 'The complete approved specialist operation set is required.');
  }
  if (Object.keys(ownership).length !== operations.length) throw sourceError('SPECIALIST_OWNERSHIP_VIOLATION', 'Every specialist operation must have exactly one trusted owner.');

  validated.sort((left, right) => componentKey(left).localeCompare(componentKey(right), 'en-US'));
  return { operations: validated, sourceHash: stableHash(validated) };
}

function approvedComponents(plan) {
  const approved = new Map();
  for (const component of plan.components || []) {
    const key = componentKey(component);
    if (approved.has(key)) throw sourceError('SPECIALIST_SCOPE_VIOLATION', 'Approved metadata components must be unique.');
    approved.set(key, component);
  }
  return approved;
}

function parseOperation(operation) {
  const parsed = SPECIALIST_OPERATION_SCHEMA.safeParse(operation);
  if (!parsed.success) throw sourceError('SPECIALIST_SOURCE_INVALID', 'Specialist source operation does not match the strict contract.');
  return parsed.data;
}

function assertDocumentSize(content) {
  if (Buffer.byteLength(String(content || ''), 'utf8') > MAX_METADATA_XML_BYTES) {
    throw sourceError('SPECIALIST_SOURCE_TOO_LARGE', 'Specialist source document exceeds the configured size limit.');
  }
}

function assertUniqueIdentity(operation, seenPaths, seenComponents) {
  const pathIdentity = operation.path.normalize('NFC').toLocaleLowerCase('en-US');
  const componentIdentity = componentKey(operation).normalize('NFC').toLocaleLowerCase('en-US');
  if (seenPaths.has(pathIdentity) || seenComponents.has(componentIdentity)) throw sourceError('SPECIALIST_PATH_VIOLATION', 'Specialist metadata path or component identity is duplicated.');
  seenPaths.add(pathIdentity);
  seenComponents.add(componentIdentity);
}

function assertOwnership(operation, component, ownership) {
  const actualOwner = ownership[operation.path];
  const expectedOwner = specialistIdForArchitectureOwner(component.owner) || component.owner;
  if (!actualOwner || actualOwner !== expectedOwner || ownerForMetadataType(operation.metadataType) !== expectedOwner) {
    throw sourceError('SPECIALIST_OWNERSHIP_VIOLATION', 'Specialist source does not match its trusted owner.');
  }
  try {
    assertSpecialistOwnsFile(actualOwner, operation.path);
  } catch {
    throw sourceError('SPECIALIST_OWNERSHIP_VIOLATION', 'Specialist source path does not match its trusted owner.');
  }
}

function assertNoSecretOrScript(content) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) throw sourceError('SPECIALIST_SECRET_DETECTED', 'Specialist source contains prohibited credential material.');
  if (SCRIPT_PATTERNS.some((pattern) => pattern.test(content))) throw sourceError('SPECIALIST_SCRIPT_DETECTED', 'Specialist source contains a prohibited executable payload.');
}

function validateMetadataSource(operation, operations, plan, inspection) {
  if (operation.metadataType === 'CustomField') return validateCustomField(operation);
  if (SECURITY_TYPES.has(operation.metadataType)) return validateSecurity(operation, operations);
  if (operation.metadataType === 'Flow') return validateFlow(operation, operations, plan, inspection);
  throw sourceError('SPECIALIST_SCOPE_VIOLATION', 'Metadata type is not supported by the Phase 1 source validator.');
}

function validateCustomField(operation) {
  const xml = parseMetadataXml(operation.content, 'CustomField');
  const fieldName = operation.apiName.split('.').at(-1);
  if (xml.children(xml.root, 'fullName').length !== 1 || xml.text(xml.root, 'fullName') !== fieldName) throw sourceError('SPECIALIST_SCOPE_VIOLATION', 'CustomField source does not match the approved API identity.');
  if (xml.children(xml.root, 'type').length !== 1 || xml.text(xml.root, 'type') !== 'Number') throw sourceError('SPECIALIST_SOURCE_INCOMPLETE', 'The approved installment field must remain a Number.');
  const precision = optionalInteger(xml, 'precision');
  const scale = optionalInteger(xml, 'scale');
  if ((precision !== null && (precision < 1 || precision > 18)) || (scale !== null && (scale < 0 || scale > 18)) || (precision !== null && scale !== null && scale > precision)) {
    throw sourceError('SPECIALIST_SOURCE_INCOMPLETE', 'CustomField precision or scale is outside the approved Number bounds.');
  }
  return xml;
}

function validateSecurity(operation, operations) {
  const xml = parseMetadataXml(operation.content, operation.metadataType);
  if (containsForbiddenSecurityElement(xml.root)) throw sourceError('SPECIALIST_SCOPE_VIOLATION', 'Security source expands access beyond approved field permissions.');
  const approvedFields = new Set(operations.filter((item) => item.metadataType === 'CustomField').map((item) => item.apiName));
  const permissions = xml.children(xml.root, 'fieldPermissions');
  const fields = permissions.map((node) => xml.text(node, 'field'));
  if (!permissions.length || new Set(fields).size !== fields.length || fields.some((field) => !approvedFields.has(field))) throw sourceError('SPECIALIST_SCOPE_VIOLATION', 'Security source contains missing, duplicate, or unapproved field access.');
  if (permissions.some((node) => xml.text(node, 'readable') !== 'true' || !['true', 'false'].includes(xml.text(node, 'editable')))) throw sourceError('SPECIALIST_SOURCE_INCOMPLETE', 'Security field access must explicitly declare readable and editable values.');
  return xml;
}

function validateFlow(operation, operations, plan, inspection) {
  const fields = operations.filter((item) => item.metadataType === 'CustomField');
  if (fields.length !== 1) throw sourceError('SPECIALIST_EVIDENCE_INVALID', 'Flow validation requires one approved installment field.');
  const [objectApiName, installmentField] = fields[0].apiName.split('.');
  return validateFlowSource({
    content: operation.content,
    approvedBehavior: {
      sourceOrgId: plan.trustedBinding.sourceOrgId,
      flowApiName: operation.apiName,
      objectApiName,
      installmentField,
      evidenceIds: relevantFlowEvidenceIds(plan, inspection, operation.apiName, objectApiName)
    },
    inspection
  });
}

function containsForbiddenSecurityElement(node) {
  return FORBIDDEN_SECURITY_ELEMENTS.has(node.name) || (node.children || []).some(containsForbiddenSecurityElement);
}

function relevantFlowEvidenceIds(plan, inspection, flowApiName, objectApiName) {
  const approvedEvidenceIds = new Set(plan.evidenceIds || []);
  return (inspection.evidence || [])
    .filter((item) => approvedEvidenceIds.has(item.evidenceId))
    .filter((item) =>
      (['RELATIONSHIP', 'STATUS_VALUE'].includes(item.kind) && item.objectApiName === objectApiName)
      || (item.kind === 'RETRIEVED_COMPONENT' && item.componentType === 'Flow' && item.componentApiName === flowApiName)
    )
    .map((item) => item.evidenceId);
}

function optionalInteger(xml, name) {
  const nodes = xml.children(xml.root, name);
  if (!nodes.length) return null;
  const value = nodes[0].text.trim();
  if (nodes.length !== 1 || !/^\d+$/.test(value)) throw sourceError('SPECIALIST_SOURCE_INCOMPLETE', `CustomField ${name} must be one bounded integer.`);
  return Number(value);
}

function assertTrustedInspection(plan, inspection) {
  const binding = plan.trustedBinding || {};
  if (!binding.inspectionHash || binding.inspectionHash !== inspection.hash || !binding.sourceOrgId || !inspection.sourceOrgId || !sameSalesforceId(binding.sourceOrgId, inspection.sourceOrgId)) {
    throw sourceError('SPECIALIST_EVIDENCE_INVALID', 'Specialist source is not bound to the approved inspection and source org.');
  }
}

function componentKey(component) {
  return `${component.operation}:${component.metadataType}:${component.apiName}`;
}

function sourceError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
