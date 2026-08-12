import { architecturePlanHashes, parseArchitecturePlan } from '../domain/architecturePlan.js';
import { canonicalInspectionHash, parseVerifiedInspection } from '../domain/inspection.js';
import { enrichPlanWithModel } from './modelExecutor.js';
import { sameSalesforceId } from '../utils/salesforceId.js';

export function createProductionArchitecturePlannerDependencies(overrides = {}) {
  const modelExecutor = overrides.modelExecutor || enrichPlanWithModel;
  return {
    modelRunner: async ({ requirement, inspection, answers, orgContext }) => modelExecutor({
      requirement,
      inspection,
      answers,
      orgContext
    })
  };
}

export async function createArchitecturePlan({ requirement, inspection, orgContext, answers = [] }, dependencies = {}) {
  const verifiedOrgId = verifiedOrgIdFor(orgContext);
  try {
    inspection = parseVerifiedInspection(inspection, { orgContext, clock: dependencies.clock, maxEvidenceAgeMs: dependencies.maxEvidenceAgeMs });
  } catch (error) {
    throw controlledPlanningError(error.code || 'INSPECTION_EVIDENCE_REQUIRED', controlledInspectionMessage(error));
  }
  assertVerifiedInspectionEvidence(inspection, verifiedOrgId);
  assertNoMaterialAmbiguity(inspection);
  assertPaidStatusVerified(requirement, inspection, answers);

  if (!dependencies.modelRunner) {
    throw controlledPlanningError('PLANNING_MODEL_UNAVAILABLE', 'Architecture planning requires the configured model executor.');
  }
  let draft;
  try {
    draft = await dependencies.modelRunner({ requirement, inspection: plannerInspectionView(inspection), answers, orgContext });
  } catch (error) {
    throw controlledPlanningError(error.code || 'PLANNING_MODEL_FAILED', 'Architecture planning could not be completed with the configured model executor.');
  }
  const plan = parsePlanClosed(draft);
  assertEvidenceIdsExist(plan.evidenceIds, inspection, verifiedOrgId);
  const trustedBinding = {
    inspectionHash: canonicalInspectionHash(inspection),
    sourceOrgId: verifiedOrgId
  };
  const hashes = architecturePlanHashes({ ...plan, trustedBinding });
  return {
    ...plan,
    trustedBinding,
    planHash: hashes.planHash,
    scopeHash: hashes.scopeHash,
    materialChangeHash: hashes.scopeHash
  };
}

function assertVerifiedInspectionEvidence(inspection, verifiedOrgId) {
  if (!inspection || !Array.isArray(inspection.evidence) || inspection.evidence.length === 0) {
    throw Object.assign(new Error('Verified inspection evidence is required for architecture planning.'), { code: 'INSPECTION_EVIDENCE_REQUIRED', statusCode: 409 });
  }
  if (!inspection.hash) {
    throw Object.assign(new Error('Verified inspection hash is required for architecture planning.'), { code: 'INSPECTION_HASH_REQUIRED', statusCode: 409 });
  }
  if (!sameSalesforceId(inspection.sourceOrgId, verifiedOrgId)) {
    throw Object.assign(new Error('Inspection evidence must come from the authenticated verified Salesforce org.'), { code: 'INSPECTION_ORG_MISMATCH', statusCode: 409 });
  }
  const seen = new Set();
  for (const item of inspection.evidence) {
    if (!item?.evidenceId || !item.kind || !item.sourceOrgId) {
      throw Object.assign(new Error('Verified inspection evidence is required for architecture planning.'), { code: 'INSPECTION_EVIDENCE_REQUIRED', statusCode: 409 });
    }
    if (seen.has(item.evidenceId)) {
      throw Object.assign(new Error('Inspection evidence contains duplicate evidence IDs.'), { code: 'DUPLICATED_INSPECTION_EVIDENCE', statusCode: 409 });
    }
    seen.add(item.evidenceId);
    if (item.stale === true || item.active === false) {
      throw Object.assign(new Error('Inspection evidence must be active and current.'), { code: 'STALE_INSPECTION_EVIDENCE', statusCode: 409 });
    }
    if (!sameSalesforceId(item.sourceOrgId, verifiedOrgId)) {
      throw Object.assign(new Error('Inspection evidence must match the authenticated verified Salesforce org.'), { code: 'EVIDENCE_ORG_MISMATCH', statusCode: 409 });
    }
  }
}

function assertNoMaterialAmbiguity(inspection) {
  const material = (inspection.ambiguities || []).find((item) => item.material);
  if (material) {
    throw Object.assign(new Error(material.question || 'Material clarification is required before planning.'), {
      code: 'MATERIAL_CLARIFICATION_REQUIRED',
      statusCode: 409,
      ambiguityId: material.ambiguityId
    });
  }
}

function assertPaidStatusVerified(requirement, inspection, answers) {
  const requirementText = requirementTextFor(requirement);
  const answerText = (answers || []).map((answer) => typeof answer === 'string' ? answer : answer?.text).filter(Boolean).join(' ');
  const requirementMentionsPaid = /\bpaid\b/i.test(requirementText);
  const requirementMentionsCompleted = /\bcompleted\b/i.test(requirementText);
  const answerMentionsPaid = /\bpaid\b/i.test(answerText);
  const answerMentionsCompleted = /\bcompleted\b/i.test(answerText);
  if (requirementMentionsPaid && requirementMentionsCompleted && !answerMentionsPaid && !answerMentionsCompleted) {
    throw clarificationRequired('Confirm whether Paid or Completed is the verified qualifying status before planning.');
  }
  if (answerMentionsPaid && answerMentionsCompleted) {
    throw clarificationRequired('Choose one verified active qualifying status before planning.');
  }
  const requiredStatus = answerMentionsPaid ? 'paid'
    : answerMentionsCompleted ? 'completed'
      : requirementMentionsPaid && !requirementMentionsCompleted ? 'paid'
        : requirementMentionsCompleted && !requirementMentionsPaid ? 'completed'
          : '';
  if (!requiredStatus && (requirementMentionsPaid || requirementMentionsCompleted)) {
    throw clarificationRequired('Confirm the verified qualifying status before planning.');
  }
  if (!requiredStatus) return;
  const matching = (inspection.evidence || [])
    .filter((item) => item.kind === 'STATUS_VALUE' && String(item.value || '').toLowerCase() === requiredStatus && item.active !== false && item.stale !== true);
  if (matching.length !== 1) {
    throw clarificationRequired(`Confirm the verified active ${requiredStatus} status before planning source changes.`);
  }
}

function clarificationRequired(message) {
  return Object.assign(new Error(message), {
    code: 'MATERIAL_CLARIFICATION_REQUIRED',
    statusCode: 409
  });
}

function assertEvidenceIdsExist(evidenceIds, inspection, verifiedOrgId) {
  const known = new Map(inspection.evidence.map((item) => [item.evidenceId, item]));
  const used = new Set();
  for (const id of evidenceIds) {
    if (used.has(id)) throw Object.assign(new Error(`Architecture plan references duplicated inspection evidence: ${id}`), { code: 'DUPLICATED_INSPECTION_EVIDENCE', statusCode: 409 });
    used.add(id);
    const evidence = known.get(id);
    if (!evidence) throw Object.assign(new Error(`Architecture plan references unknown inspection evidence: ${id}`), { code: 'UNKNOWN_INSPECTION_EVIDENCE', statusCode: 409 });
    if (!sameSalesforceId(evidence.sourceOrgId, verifiedOrgId)) {
      throw Object.assign(new Error('Architecture plan references evidence from a different Salesforce org.'), { code: 'EVIDENCE_ORG_MISMATCH', statusCode: 409 });
    }
    if (evidence.stale === true || evidence.active === false) {
      throw Object.assign(new Error('Architecture plan references stale inspection evidence.'), { code: 'STALE_INSPECTION_EVIDENCE', statusCode: 409 });
    }
  }
}

function parsePlanClosed(draft) {
  try {
    return parseArchitecturePlan(draft);
  } catch {
    throw Object.assign(new Error('Architecture planning returned an invalid source-free plan.'), {
      code: 'ARCHITECTURE_PLAN_SCHEMA_INVALID',
      statusCode: 409
    });
  }
}

function controlledPlanningError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function controlledInspectionMessage(error) {
  if (error?.code === 'INSPECTION_ORG_MISMATCH') return error.message;
  if (error?.code === 'INSPECTION_HASH_MISMATCH') return 'Inspection hash must match the verified inspection content.';
  if (error?.code === 'EVIDENCE_ORG_MISMATCH') return error.message;
  if (error?.code === 'DUPLICATED_INSPECTION_EVIDENCE') return error.message;
  if (error?.code === 'STALE_INSPECTION_EVIDENCE') return error.message;
  return 'Verified inspection evidence is required for architecture planning.';
}

function verifiedOrgIdFor(orgContext) {
  const expected = orgContext?.expectedOrgId;
  const verified = orgContext?.verified?.organizationId;
  if (!expected || !sameSalesforceId(expected, verified)) {
    throw Object.assign(new Error('A verified Salesforce org context is required for architecture planning.'), { code: 'VERIFIED_ORG_REQUIRED', statusCode: 409 });
  }
  return expected;
}

function plannerInspectionView(inspection) {
  return {
    hash: canonicalInspectionHash(inspection),
    sourceOrgId: inspection.sourceOrgId,
    objects: inspection.objects || [],
    fields: inspection.fields || [],
    relationships: inspection.relationships || [],
    statusCandidates: inspection.statusCandidates || [],
    flows: inspection.flows || [],
    apexAutomation: inspection.apexAutomation || [],
    validationRules: inspection.validationRules || [],
    layouts: inspection.layouts || [],
    permissionSets: inspection.permissionSets || [],
    evidence: inspection.evidence || []
  };
}

function requirementTextFor(requirement) {
  return String(requirement?.businessRequirement || requirement?.summary || requirement || '').trim();
}
