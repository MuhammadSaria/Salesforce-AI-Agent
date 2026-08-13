import { z } from 'zod';
import { config } from '../config.js';
import { sameSalesforceId } from '../utils/salesforceId.js';

const common = {
  evidenceId: z.string().min(1).max(200),
  sourceOrgId: z.string().min(15).max(18),
  active: z.literal(true),
  stale: z.literal(false),
  observedAt: z.string().datetime({ offset: true })
};
const api = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:__c)?$/);
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:__(?:c|pc)|Id)?$/);
const componentApi = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]*$/);
const schemas = {
  OBJECT: z.object({ ...common, kind: z.literal('OBJECT'), componentType: z.literal('CustomObject'), componentApiName: api }).strict(),
  FIELD: z.object({ ...common, kind: z.literal('FIELD'), objectApiName: api, fieldApiName: field, componentType: z.literal('CustomField'), componentApiName: componentApi }).strict(),
  RELATIONSHIP: z.object({ ...common, kind: z.literal('RELATIONSHIP'), objectApiName: api, fieldApiName: field, targetObjectApiName: api, componentType: z.literal('CustomField'), componentApiName: componentApi }).strict(),
  STATUS_VALUE: z.object({ ...common, kind: z.literal('STATUS_VALUE'), objectApiName: api, fieldApiName: field, value: z.string().min(1).max(255), componentType: z.literal('CustomField'), componentApiName: componentApi }).strict(),
  RETRIEVED_COMPONENT: z.object({ ...common, kind: z.literal('RETRIEVED_COMPONENT'), componentType: z.enum(['CustomField', 'Flow', 'PermissionSet', 'PermissionSetGroup', 'MutingPermissionSet', 'Profile', 'CustomPermission']), componentApiName: componentApi, retrievedSource: z.string().max(500000) }).strict()
};
const union = z.discriminatedUnion('kind', Object.values(schemas));

export function validateSpecialistEvidence(evidence, context) {
  let parsed;
  try { parsed = z.array(union).max(100).parse(evidence); } catch (cause) { throw evidenceError('Malformed specialist evidence.', cause); }
  const seen = new Set();
  const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
  const maxAge = Number(context.maxAgeMs ?? config.maxOrgVerificationAgeMs);
  for (const item of parsed) {
    if (seen.has(item.evidenceId)) throw evidenceError('Duplicate specialist evidence ID.');
    seen.add(item.evidenceId);
    if (item.sourceOrgId !== context.sourceOrgId && !sameSalesforceId(item.sourceOrgId, context.sourceOrgId)) throw evidenceError('Specialist evidence must match the verified source org.');
    const observed = new Date(item.observedAt);
    if (!Number.isFinite(observed.getTime()) || observed > now || now.getTime() - observed.getTime() > maxAge) throw evidenceError('Specialist evidence is not current.');
  }
  assertBoundToSpecialist(parsed, context);
  return parsed;
}

function assertBoundToSpecialist(items, context) {
  const approved = new Set((context.approvedComponents || []).map((item) => `${item.metadataType}:${item.apiName}`));
  const fieldObjects = new Set((context.dependencyResults || []).flatMap((dependency) => dependency.operations || []).filter((operation) => operation.metadataType === 'CustomField').map((operation) => operation.apiName.split('.')[0]));
  const inferredObjects = fieldObjects.size ? fieldObjects : new Set(items.filter((item) => item.kind === 'STATUS_VALUE').map((item) => item.objectApiName));
  const approvedFieldObjects = new Set((context.approvedComponents || []).filter((item) => item.metadataType === 'CustomField').map((item) => item.apiName.split('.')[0]));
  for (const item of items) {
    if (item.kind === 'RETRIEVED_COMPONENT' && !approved.has(`${item.componentType}:${item.componentApiName}`)) throw evidenceError('Retrieved evidence is not for an approved component.');
    if (context.specialistId === 'FLOW' && ['RELATIONSHIP', 'STATUS_VALUE'].includes(item.kind) && inferredObjects.size && !inferredObjects.has(item.objectApiName)) throw evidenceError('Flow evidence is for an unrelated object.');
    if (context.specialistId === 'FLOW' && item.kind === 'RELATIONSHIP' && !/commitment|recurring/i.test(item.targetObjectApiName)) throw evidenceError('Flow relationship evidence is unrelated to the recurring parent.');
    if (context.specialistId === 'OBJECT_FIELD' && ['FIELD', 'RELATIONSHIP'].includes(item.kind) && !approvedFieldObjects.has(item.objectApiName)) throw evidenceError('Object/field evidence is for an unrelated object.');
    if (context.specialistId === 'OBJECT_FIELD' && item.kind === 'OBJECT' && !approvedFieldObjects.has(item.componentApiName)) throw evidenceError('Object evidence is for an unrelated object.');
  }
}

function evidenceError(message, cause) {
  return Object.assign(new Error(message), { code: 'SPECIALIST_EVIDENCE_INVALID', statusCode: 409, cause });
}
