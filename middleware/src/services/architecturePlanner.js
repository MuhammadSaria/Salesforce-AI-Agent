import { architecturePlanHashes, parseArchitecturePlan } from '../domain/architecturePlan.js';

export async function createArchitecturePlan({ requirement, inspection, answers = [] }, dependencies = {}) {
  assertVerifiedInspectionEvidence(inspection);
  assertNoMaterialAmbiguity(inspection);
  assertPaidStatusVerified(requirement, inspection, answers);

  const draft = dependencies.modelRunner
    ? await dependencies.modelRunner({ requirement, inspection: plannerInspectionView(inspection), answers })
    : deterministicPlan({ requirement, inspection, answers });
  const plan = parseArchitecturePlan(draft);
  assertEvidenceIdsExist(plan.evidenceIds, inspection);
  const hashes = architecturePlanHashes(plan);
  return {
    ...plan,
    planHash: hashes.planHash,
    scopeHash: hashes.scopeHash,
    materialChangeHash: hashes.scopeHash
  };
}

function deterministicPlan({ requirement, inspection }) {
  const requirementText = requirementTextFor(requirement);
  const evidenceIds = inspection.evidence.map((item) => item.evidenceId).sort();
  const components = deterministicComponents(inspection);
  return {
    requirement: requirementText,
    acceptanceCriteria: normalizedCriteria(requirement),
    assumptions: [],
    evidenceIds,
    components,
    expectedBehavior: ['The verified Salesforce org implements the requested behavior using only approved component intents.'],
    testingStrategy: ['Validate the approved component behavior in the same verified Salesforce org before deployment approval.'],
    risks: risksFor(requirementText),
    rollbackStrategy: 'Withdraw implementation approval or remove generated metadata before deployment; after deployment, use the separately approved rollback process.'
  };
}

function deterministicComponents(inspection) {
  const components = [];
  for (const field of inspection.fields || []) {
    components.push({ operation: 'modify', metadataType: 'CustomField', apiName: field.objectApiName ? `${field.objectApiName}.${field.apiName}` : field.apiName, owner: 'object-field-specialist', reason: 'Use verified field behavior in the approved design.' });
  }
  for (const permissionSet of inspection.permissionSets || []) {
    components.push({ operation: 'modify', metadataType: 'PermissionSet', apiName: permissionSet.apiName, owner: 'security-specialist', reason: 'Grant only approved access required by the behavior.' });
  }
  const flowName = (inspection.flows || []).find((flow) => flow.apiName)?.apiName || 'Providus_Nexus_Requested_Flow';
  components.push({ operation: (inspection.flows || []).length ? 'modify' : 'create', metadataType: 'Flow', apiName: flowName, owner: 'flow-specialist', reason: 'Implement the requested automation behavior after approval.' });
  return components.sort((left, right) => `${left.metadataType}:${left.apiName}`.localeCompare(`${right.metadataType}:${right.apiName}`));
}

function assertVerifiedInspectionEvidence(inspection) {
  if (!inspection || !Array.isArray(inspection.evidence) || inspection.evidence.length === 0) {
    throw Object.assign(new Error('Verified inspection evidence is required for architecture planning.'), { code: 'INSPECTION_EVIDENCE_REQUIRED', statusCode: 409 });
  }
  for (const item of inspection.evidence) {
    if (!item?.evidenceId || !item.kind || !item.sourceOrgId) {
      throw Object.assign(new Error('Verified inspection evidence is required for architecture planning.'), { code: 'INSPECTION_EVIDENCE_REQUIRED', statusCode: 409 });
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
  const text = `${requirementTextFor(requirement)} ${(answers || []).join(' ')}`;
  if (!/\b(paid|completed)\b/i.test(text)) return;
  const statusValues = new Set((inspection.evidence || [])
    .filter((item) => item.kind === 'STATUS_VALUE')
    .map((item) => String(item.value || '').toLowerCase()));
  if (!statusValues.has('paid') && !statusValues.has('completed')) {
    throw Object.assign(new Error('Confirm the verified paid or completed status before planning source changes.'), {
      code: 'MATERIAL_CLARIFICATION_REQUIRED',
      statusCode: 409
    });
  }
}

function assertEvidenceIdsExist(evidenceIds, inspection) {
  const known = new Set(inspection.evidence.map((item) => item.evidenceId));
  const unknown = evidenceIds.filter((id) => !known.has(id));
  if (unknown.length) throw Object.assign(new Error(`Architecture plan references unknown inspection evidence: ${unknown.join(', ')}`), { code: 'UNKNOWN_INSPECTION_EVIDENCE', statusCode: 409 });
}

function plannerInspectionView(inspection) {
  return {
    hash: inspection.hash,
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

function normalizedCriteria(requirement) {
  const criteria = Array.isArray(requirement?.acceptanceCriteria) ? requirement.acceptanceCriteria.filter(Boolean) : [];
  return criteria.length ? criteria : ['The approved behavior is observable in the verified Salesforce org.'];
}

function requirementTextFor(requirement) {
  return String(requirement?.businessRequirement || requirement?.summary || requirement || '').trim();
}

function risksFor(requirementText) {
  if (/\b(sequence|sequential|number)\b/i.test(requirementText)) {
    return ['Concurrent completed donations can require a locking-capable design to guarantee strict uniqueness.'];
  }
  return [];
}

