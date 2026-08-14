import { z } from 'zod';
import { config } from '../config.js';
import { stableHash } from '../utils/hash.js';
import { sameSalesforceId } from '../utils/salesforceId.js';

export const INSPECTION_EVIDENCE_KINDS = Object.freeze([
  'OBJECT',
  'FIELD',
  'RELATIONSHIP',
  'STATUS_CANDIDATE',
  'STATUS_VALUE',
  'FLOW',
  'APEX_AUTOMATION',
  'VALIDATION_RULE',
  'LAYOUT',
  'PERMISSION_SET'
]);

const API_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:__c)?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:__(?:c|pc|r)|Id)?$/;
const ISO_DATE = z.string().datetime({ offset: true });

const evidenceSchema = z.object({
  evidenceId: z.string().min(1).max(200),
  kind: z.enum(INSPECTION_EVIDENCE_KINDS),
  objectApiName: z.string().max(255).optional(),
  fieldApiName: z.string().max(255).optional(),
  targetObjectApiName: z.string().max(255).optional(),
  componentType: z.string().max(80).optional(),
  componentApiName: z.string().max(255).optional(),
  value: z.string().max(255).optional(),
  label: z.string().max(255).optional(),
  operationId: z.string().max(255).optional(),
  sourceOrgId: z.string().min(15).max(18),
  active: z.literal(true),
  observedAt: ISO_DATE
}).passthrough().superRefine((item, ctx) => {
  const requireApi = (field) => {
    const value = item[field];
    if (!value || !API_NAME.test(String(value).replace(/\..+$/, ''))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for ${item.kind} evidence.` });
    }
  };
  const requireField = () => {
    if (!item.fieldApiName || !FIELD_NAME.test(item.fieldApiName)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fieldApiName'], message: `fieldApiName is required for ${item.kind} evidence.` });
    }
  };
  if (['OBJECT'].includes(item.kind)) requireApi('componentApiName');
  if (['FIELD', 'STATUS_CANDIDATE', 'STATUS_VALUE', 'RELATIONSHIP'].includes(item.kind)) {
    requireApi('objectApiName');
    requireField();
  }
  if (item.kind === 'RELATIONSHIP') requireApi('targetObjectApiName');
  if (item.kind === 'STATUS_VALUE' && !String(item.value || '').trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'value is required for STATUS_VALUE evidence.' });
  }
  if (['FLOW', 'APEX_AUTOMATION', 'VALIDATION_RULE', 'LAYOUT', 'PERMISSION_SET'].includes(item.kind)) {
    if (!item.componentType || !item.componentApiName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `component identity is required for ${item.kind} evidence.` });
    }
  }
});

export const INSPECTION_SCHEMA = z.object({
  hash: z.string().optional(),
  sourceOrgId: z.string().min(15).max(18),
  objects: z.array(z.unknown()).default([]),
  fields: z.array(z.unknown()).default([]),
  relationships: z.array(z.unknown()).default([]),
  statusCandidates: z.array(z.unknown()).default([]),
  flows: z.array(z.unknown()).default([]),
  apexAutomation: z.array(z.unknown()).default([]),
  validationRules: z.array(z.unknown()).default([]),
  layouts: z.array(z.unknown()).default([]),
  permissionSets: z.array(z.unknown()).default([]),
  evidence: z.array(evidenceSchema),
  ambiguities: z.array(z.unknown()).default([]),
  componentKeys: z.array(z.unknown()).default([]),
  primaryMetadata: z.array(z.unknown()).default([]),
  relatedMetadata: z.array(z.unknown()).default([]),
  dependencies: z.array(z.unknown()).default([]),
  excludedMetadata: z.array(z.string()).default([]),
  maximumDependencyDepth: z.number().optional(),
  maximumComponents: z.number().optional()
}).passthrough();

export function canonicalInspectionHash(inspection) {
  const body = JSON.parse(JSON.stringify(INSPECTION_SCHEMA.parse({ ...inspection, hash: undefined })));
  delete body.hash;
  body.evidence = body.evidence.map((item) => ({ ...item, observedAt: '' }));
  return stableHash(body);
}

export function parseVerifiedInspection(inspection, options = {}) {
  const parsed = INSPECTION_SCHEMA.parse(inspection);
  if (!parsed.evidence.length) throw integrityError('INSPECTION_EVIDENCE_REQUIRED', 'Verified inspection evidence is required.');
  const now = (options.clock || (() => new Date()))().getTime();
  const expectedOrgId = verifiedOrgIdFor(options.orgContext, now);
  if (!sameSalesforceId(parsed.sourceOrgId, expectedOrgId)) throw integrityError('INSPECTION_ORG_MISMATCH', 'Inspection evidence must come from the authenticated verified Salesforce org.');
  const maxAgeMs = Number(options.maxEvidenceAgeMs ?? config.maxOrgVerificationAgeMs);
  const seen = new Set();
  for (const item of parsed.evidence) {
    if (seen.has(item.evidenceId)) throw integrityError('DUPLICATED_INSPECTION_EVIDENCE', 'Inspection evidence contains duplicate evidence IDs.');
    seen.add(item.evidenceId);
    if (!sameSalesforceId(item.sourceOrgId, expectedOrgId)) throw integrityError('EVIDENCE_ORG_MISMATCH', 'Inspection evidence must match the authenticated verified Salesforce org.');
    const observedAt = Date.parse(item.observedAt);
    if (!Number.isFinite(observedAt) || observedAt > now + 30000 || now - observedAt > maxAgeMs) {
      throw integrityError('STALE_INSPECTION_EVIDENCE', 'Inspection evidence must be active and current.');
    }
  }
  const actualHash = canonicalInspectionHash(parsed);
  if (!parsed.hash || parsed.hash !== actualHash) throw integrityError('INSPECTION_HASH_MISMATCH', 'Inspection hash must match the verified inspection content.');
  return parsed;
}

function verifiedOrgIdFor(orgContext = {}, now = Date.now()) {
  const verified = orgContext?.verified || {};
  const verifiedAt = Date.parse(verified.verifiedAt || '');
  const maxAgeMs = Number(config.maxOrgVerificationAgeMs);
  if (!verified.organizationId || !orgContext.expectedOrgId || !sameSalesforceId(verified.organizationId, orgContext.expectedOrgId)) {
    throw integrityError('VERIFIED_ORG_REQUIRED', 'A verified Salesforce org context is required.');
  }
  if (!Number.isFinite(verifiedAt) || verifiedAt > now + 30000 || now - verifiedAt > maxAgeMs) {
    throw integrityError('VERIFIED_ORG_CONTEXT_STALE', 'Salesforce org verification is missing, invalid, future-dated, or expired.');
  }
  return orgContext.expectedOrgId;
}

function integrityError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
