import { z } from 'zod';
import { stableHash } from '../utils/hash.js';

const sourceTerms = [
  /<\?xml/i,
  /<[A-Za-z]+(?:\s|>)/,
  /\bpublic\s+class\b/i,
  /\btrigger\s+\w+\s+on\b/i,
  /\b(?:const|let|var)\s+\w+\s*=/,
  /\bfunction\s+\w+\s*\(/,
  /\bimport\s+[\w{]/,
  /\bexport\s+(?:default\s+)?(?:class|function|const|let|var)\b/,
  /\bsf(?:\.cmd)?\s+/i,
  /\bsfdx\s+/i,
  /\bgit\s+(?:add|commit|push|checkout|reset|clean|worktree)\b/i,
  /\bnpm(?:\.cmd)?\s+/i
];

const sourceFreeString = (max) => z.string().min(1).max(max).superRefine((value, ctx) => {
  if (sourceTerms.some((pattern) => pattern.test(value))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Architecture plans must not contain source code, XML, JavaScript, Apex, or shell commands.' });
  }
});

export const ARCHITECTURE_PLAN_SCHEMA = z.object({
  requirement: sourceFreeString(8000),
  acceptanceCriteria: z.array(sourceFreeString(1000)).min(1).max(25),
  assumptions: z.array(sourceFreeString(1000)).max(20),
  evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  components: z.array(z.object({
    operation: z.enum(['create', 'modify', 'delete']),
    metadataType: z.string().min(1).max(120),
    apiName: z.string().min(1).max(255),
    owner: z.string().min(1).max(120),
    reason: sourceFreeString(1000)
  }).strict()).min(1).max(50),
  expectedBehavior: z.array(sourceFreeString(1000)).min(1).max(30),
  testingStrategy: z.array(sourceFreeString(1000)).min(1).max(30),
  risks: z.array(sourceFreeString(1000)).max(30),
  rollbackStrategy: sourceFreeString(2000)
}).strict().superRefine((plan, ctx) => {
  const serialized = JSON.stringify(plan);
  if (/\b(fileOperations|content|source|generatedFiles|completeFiles)\b/i.test(serialized)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Architecture plans must not contain source-generation fields.' });
  }
});

export function parseArchitecturePlan(plan) {
  return ARCHITECTURE_PLAN_SCHEMA.parse(plan);
}

export function architecturePlanCore(plan) {
  return parseArchitecturePlan({
    requirement: plan?.requirement,
    acceptanceCriteria: plan?.acceptanceCriteria,
    assumptions: plan?.assumptions,
    evidenceIds: plan?.evidenceIds,
    components: plan?.components,
    expectedBehavior: plan?.expectedBehavior,
    testingStrategy: plan?.testingStrategy,
    risks: plan?.risks,
    rollbackStrategy: plan?.rollbackStrategy
  });
}

export function architecturePlanHashes(plan) {
  const core = architecturePlanCore(plan);
  return {
    planHash: stableHash(core),
    scopeHash: stableHash(core.components.map(({ operation, metadataType, apiName, owner }) => ({ operation, metadataType, apiName, owner })))
  };
}
