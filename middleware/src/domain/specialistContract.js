import { z } from 'zod';
import {
  PHASE1_IMPLEMENTATION_SPECIALIST_IDS
} from './specialistAgents.js';

export const SPECIALIST_STATUSES = Object.freeze({
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED'
});

export const SPECIALIST_OPERATION_SCHEMA = z.object({
  operation: z.enum(['create', 'modify', 'delete']),
  path: z.string().min(1).max(500),
  content: z.string().max(500000),
  metadataType: z.string().min(1).max(100),
  apiName: z.string().min(1).max(255),
  reason: z.string().min(1).max(1000)
}).strict();

const specialistId = z.enum(PHASE1_IMPLEMENTATION_SPECIALIST_IDS);

const approvedComponent = z.object({
  operation: z.enum(['create', 'modify', 'delete']),
  metadataType: z.string().min(1).max(100),
  apiName: z.string().min(1).max(255),
  owner: specialistId,
  reason: z.string().min(1).max(1000)
}).strict();

const evidenceCommon = {
  evidenceId: z.string().min(1).max(200), sourceOrgId: z.string().min(15).max(18),
  active: z.literal(true), stale: z.literal(false), observedAt: z.string().datetime({ offset: true })
};
const inspectionEvidence = z.discriminatedUnion('kind', [
  z.object({ ...evidenceCommon, kind: z.literal('OBJECT'), componentType: z.literal('CustomObject'), componentApiName: z.string() }).strict(),
  z.object({ ...evidenceCommon, kind: z.literal('FIELD'), objectApiName: z.string(), fieldApiName: z.string(), componentType: z.literal('CustomField'), componentApiName: z.string() }).strict(),
  z.object({ ...evidenceCommon, kind: z.literal('RELATIONSHIP'), objectApiName: z.string(), fieldApiName: z.string(), targetObjectApiName: z.string(), componentType: z.literal('CustomField'), componentApiName: z.string() }).strict(),
  z.object({ ...evidenceCommon, kind: z.literal('STATUS_VALUE'), objectApiName: z.string(), fieldApiName: z.string(), value: z.string(), componentType: z.literal('CustomField'), componentApiName: z.string() }).strict(),
  z.object({ ...evidenceCommon, kind: z.literal('RETRIEVED_COMPONENT'), componentType: z.string(), componentApiName: z.string(), retrievedSource: z.string().max(500000) }).strict()
]);

export const SPECIALIST_REQUEST_SCHEMA = z.object({
  specialistId,
  jobId: z.string().min(1).max(100),
  planVersion: z.number().int().positive(),
  sourceOrgId: z.string().min(15).max(18),
  workspace: z.object({
    workspacePath: z.string().min(1).max(500),
    planVersion: z.number().int().positive().optional()
  }).strict(),
  approvedComponents: z.array(approvedComponent).max(50),
  planContext: z.object({
    requirement: z.string().min(1).max(8000),
    acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(25),
    expectedBehavior: z.array(z.string().min(1).max(1000)).max(30),
    risks: z.array(z.string().min(1).max(1000)).max(30)
  }).strict(),
  inspectionEvidence: z.array(inspectionEvidence).max(100),
  dependencyResults: z.array(z.object({
    specialistId,
    status: z.enum(Object.values(SPECIALIST_STATUSES)),
    operations: z.array(SPECIALIST_OPERATION_SCHEMA).max(50),
    risks: z.array(z.string().min(1).max(1000)).max(30),
    verification: z.array(z.string().min(1).max(1000)).max(30)
  }).strict()).max(10)
}).strict();

export const SPECIALIST_RESULT_SCHEMA = z.object({
  status: z.enum(Object.values(SPECIALIST_STATUSES)),
  operations: z.array(SPECIALIST_OPERATION_SCHEMA).max(50),
  dependencies: z.array(z.string().min(1).max(100)).max(10),
  risks: z.array(z.string().min(1).max(1000)).max(30),
  verification: z.array(z.string().min(1).max(1000)).max(30),
  materialQuestion: z.string().min(1).max(1000).optional()
}).strict().superRefine((result, ctx) => {
  if (result.status === SPECIALIST_STATUSES.BLOCKED) {
    if (result.operations.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['operations'], message: 'Blocked specialists must not return operations.' });
    }
    if (!result.materialQuestion) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['materialQuestion'], message: 'Blocked specialists must include a material question.' });
    }
  }
});
