import {
  SPECIALIST_REQUEST_SCHEMA,
  SPECIALIST_RESULT_SCHEMA,
  SPECIALIST_STATUSES
} from '../domain/specialistContract.js';
import {
  PHASE1_IMPLEMENTATION_SPECIALIST_IDS,
  assertSpecialistOwnsFile,
  ownerForMetadataType,
  specialistIdForArchitectureOwner
} from '../domain/specialistAgents.js';
import { assertCanonicalOperationPath } from '../domain/metadataPath.js';

export const PHASE1_SPECIALIST_DEPENDENCIES = Object.freeze({
  OBJECT_FIELD: Object.freeze([]),
  SECURITY_PERMISSIONS: Object.freeze(['OBJECT_FIELD']),
  FLOW: Object.freeze(['OBJECT_FIELD', 'SECURITY_PERMISSIONS'])
});

export async function runSpecialists({ job, plan, inspection, workspace }, options = {}) {
  const runners = options.runners || {};
  const requiredSpecialists = normalizeRequiredSpecialists(options.requiredSpecialists || specialistsRequiredByPlan(plan));
  const dependencyGraph = normalizeDependencyGraph(options.dependencyGraph || PHASE1_SPECIALIST_DEPENDENCIES, requiredSpecialists);
  const executionPlan = topologicalSpecialists(requiredSpecialists, dependencyGraph);
  const resultsBySpecialist = {};
  const executionOrder = [];
  const suppressedSpecialists = [];

  for (const specialistId of executionPlan) {
    const dependencies = dependencyGraph[specialistId] || [];
    const blockedDependency = dependencies.find((dependency) => resultsBySpecialist[dependency]?.status === SPECIALIST_STATUSES.BLOCKED);
    const missingDependency = dependencies.find((dependency) => !resultsBySpecialist[dependency]);
    if (blockedDependency || missingDependency) {
      suppressedSpecialists.push(specialistId);
      continue;
    }

    const runner = runners[specialistId];
    if (!runner) throw specialistError('SPECIALIST_RUNNER_UNAVAILABLE', `No bounded runner is configured for ${specialistId}.`);
    const request = buildSpecialistRequest({ specialistId, job, plan, inspection, workspace, dependencyGraph, resultsBySpecialist });
    const rawResult = await runner(request);
    const result = parseSpecialistResult(specialistId, rawResult);
    assertOperationsWithinBoundary(specialistId, request.approvedComponents, result.operations);
    const traced = { specialistId, ...result, completedAt: new Date().toISOString() };
    resultsBySpecialist[specialistId] = traced;
    executionOrder.push(specialistId);
    await persistSpecialistResult(job, traced, options.jobStore);
    if (result.status === SPECIALIST_STATUSES.BLOCKED) {
      suppressedSpecialists.push(...executionPlan.slice(executionPlan.indexOf(specialistId) + 1).filter((candidate) => dependsOn(candidate, specialistId, dependencyGraph)));
    }
  }

  return {
    status: Object.values(resultsBySpecialist).some((result) => result.status === SPECIALIST_STATUSES.BLOCKED)
      ? SPECIALIST_STATUSES.BLOCKED
      : SPECIALIST_STATUSES.COMPLETED,
    executionOrder,
    resultsBySpecialist,
    suppressedSpecialists: [...new Set(suppressedSpecialists)]
  };
}

export function buildSpecialistRequest({ specialistId, job, plan, inspection, workspace, dependencyGraph, resultsBySpecialist }) {
  const approvedComponents = ownedComponents(plan, specialistId);
  const relevantApiNames = new Set(approvedComponents.map((component) => component.apiName));
  const evidenceIds = new Set(plan?.evidenceIds || []);
  const inspectionEvidence = (inspection?.evidence || []).filter((evidence) => {
    if (!evidenceIds.has(evidence.evidenceId)) return false;
    return evidenceRelevantToSpecialist(evidence, specialistId, relevantApiNames);
  }).map((evidence) => ({ ...evidence, stale: false }));
  const dependencyResults = (dependencyGraph[specialistId] || [])
    .map((dependency) => resultsBySpecialist[dependency])
    .filter(Boolean)
    .map(({ specialistId: dependencyId, status, operations, risks, verification }) => ({
      specialistId: dependencyId,
      status,
      operations,
      risks,
      verification
    }));

  return SPECIALIST_REQUEST_SCHEMA.parse({
    specialistId,
    jobId: job?.jobId,
    planVersion: Number(plan?.planVersion || job?.iteration || 1),
    sourceOrgId: plan?.trustedBinding?.sourceOrgId || inspection?.sourceOrgId || inspection?.evidence?.[0]?.sourceOrgId,
    workspace,
    approvedComponents,
    planContext: {
      requirement: plan?.requirement,
      acceptanceCriteria: plan?.acceptanceCriteria || [],
      expectedBehavior: plan?.expectedBehavior || [],
      risks: plan?.risks || []
    },
    inspectionEvidence,
    dependencyResults
  });
}

function evidenceRelevantToSpecialist(evidence, specialistId, relevantApiNames) {
  const componentApiName = evidence.componentApiName || evidence.apiName || '';
  if (componentApiName && relevantApiNames.has(componentApiName)) return true;
  if (specialistId === 'FLOW') return ['RELATIONSHIP', 'STATUS_CANDIDATE', 'STATUS_VALUE'].includes(evidence.kind);
  if (specialistId === 'OBJECT_FIELD') return ['OBJECT', 'FIELD', 'RELATIONSHIP'].includes(evidence.kind);
  return false;
}

function specialistsRequiredByPlan(plan) {
  return [...new Set((plan?.components || [])
    .map((component) => specialistIdForArchitectureOwner(component.owner))
    .filter((specialistId) => PHASE1_IMPLEMENTATION_SPECIALIST_IDS.includes(specialistId)))];
}

function ownedComponents(plan, specialistId) {
  return (plan?.components || [])
    .map((component) => ({ ...component, owner: specialistIdForArchitectureOwner(component.owner) || component.owner }))
    .filter((component) => component.owner === specialistId);
}

function normalizeRequiredSpecialists(specialists) {
  const seen = new Set();
  for (const specialistId of specialists) {
    if (!PHASE1_IMPLEMENTATION_SPECIALIST_IDS.includes(specialistId)) {
      throw specialistError('UNKNOWN_SPECIALIST', `Unknown specialist: ${specialistId}.`);
    }
    if (seen.has(specialistId)) throw specialistError('DUPLICATE_SPECIALIST', `Duplicate specialist: ${specialistId}.`);
    seen.add(specialistId);
  }
  return [...seen];
}

function normalizeDependencyGraph(graph, requiredSpecialists) {
  const required = new Set(requiredSpecialists);
  const normalized = {};
  for (const specialistId of requiredSpecialists) {
    normalized[specialistId] = [...(graph[specialistId] || [])].filter((dependency) => required.has(dependency));
  }
  for (const [specialistId, dependencies] of Object.entries(graph)) {
    if (required.has(specialistId)) {
      for (const dependency of dependencies || []) {
        if (!PHASE1_IMPLEMENTATION_SPECIALIST_IDS.includes(dependency)) {
          throw specialistError('UNKNOWN_SPECIALIST_DEPENDENCY', `Unknown specialist dependency: ${dependency}.`);
        }
      }
    }
  }
  return normalized;
}

function topologicalSpecialists(requiredSpecialists, graph) {
  const remaining = new Set(requiredSpecialists);
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter((specialistId) => (graph[specialistId] || []).every((dependency) => !remaining.has(dependency)));
    if (!ready.length) throw specialistError('SPECIALIST_DEPENDENCY_CYCLE', 'Specialist dependency graph contains a cycle.');
    ready.sort((a, b) => requiredSpecialists.indexOf(a) - requiredSpecialists.indexOf(b));
    for (const specialistId of ready) {
      ordered.push(specialistId);
      remaining.delete(specialistId);
    }
  }
  return ordered;
}

function parseSpecialistResult(specialistId, result) {
  try {
    return SPECIALIST_RESULT_SCHEMA.parse(result);
  } catch (error) {
    throw Object.assign(new Error(`Invalid ${specialistId} specialist result.`), {
      code: 'SPECIALIST_RESULT_SCHEMA_INVALID',
      statusCode: 409,
      cause: error
    });
  }
}

function assertOperationsWithinBoundary(specialistId, approvedComponents, operations) {
  const approved = new Set(approvedComponents.map((component) => componentKey(component)));
  for (const operation of operations) {
    assertCanonicalOperationPath(operation);
    const typeOwner = ownerForMetadataType(operation.metadataType);
    if (typeOwner && typeOwner !== specialistId) {
      throw specialistError('SPECIALIST_OWNERSHIP_VIOLATION', `Rejected specialist ownership violation: ${specialistId} cannot produce ${operation.metadataType} ${operation.apiName}.`);
    }
    try {
      assertSpecialistOwnsFile(specialistId, operation.path);
    } catch (error) {
      throw Object.assign(new Error(`Rejected specialist ownership violation: ${error.message}`), {
        code: 'SPECIALIST_OWNERSHIP_VIOLATION',
        statusCode: 409
      });
    }
    if (!approved.has(componentKey(operation))) {
      throw specialistError('SPECIALIST_SCOPE_VIOLATION', `Rejected specialist scope violation: ${specialistId} returned unapproved ${operation.metadataType} ${operation.apiName}.`);
    }
  }
}

async function persistSpecialistResult(job, result, jobStore) {
  if (!jobStore?.update || !job?.jobId) return;
  await jobStore.update(job.jobId, {
    specialistResults: {
      ...(job.specialistResults || {}),
      [result.specialistId]: result
    }
  });
  job.specialistResults = {
    ...(job.specialistResults || {}),
    [result.specialistId]: result
  };
}

function componentKey(component) {
  return `${component.operation}:${component.metadataType}:${component.apiName}`;
}

function dependsOn(specialistId, dependencyId, graph, seen = new Set()) {
  if (seen.has(specialistId)) return false;
  seen.add(specialistId);
  return (graph[specialistId] || []).some((dependency) => dependency === dependencyId || dependsOn(dependency, dependencyId, graph, seen));
}

function specialistError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
