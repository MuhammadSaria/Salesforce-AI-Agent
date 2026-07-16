import { nanoid } from 'nanoid';
import { stableHash } from '../utils/hash.js';
import {
  SPECIALIST_AGENTS,
  SPECIALIST_AGENT_IDS,
  SPECIALIST_MESSAGE_TYPES,
  WORK_ITEM_STATUSES,
  assertSpecialistOwnsFile,
  implementationAgentIds,
  ownerForFile,
  ownerForMetadataType,
  selectSpecialistAgents,
  specialistAgent
} from '../domain/specialistAgents.js';

export function buildSpecialistOrchestration(job, requirement, metadataScope, plan) {
  const selectedAgentIds = selectSpecialistAgents(requirement, metadataScope, plan);
  validateProposedOwnership(plan, selectedAgentIds);
  const iteration = Number(plan.planVersion || job.nextPlanVersion || 1);
  const workItems = createWorkItems(job, requirement, metadataScope, plan, selectedAgentIds, iteration);
  const messages = createDependencyMessages(job, workItems);
  const fileOwnership = createFileOwnership(plan, workItems);
  const specialistSections = workItems.map((item) => ({
    workItemId: item.workItemId,
    agentId: item.assignedSpecialistAgent,
    agentName: item.agentName,
    section: specialistAgent(item.assignedSpecialistAgent).section,
    status: item.status,
    responsibility: item.outputs.analysisSummary,
    proposedChanges: item.outputs.proposedChanges,
    dependencies: item.dependencies,
    filesAffected: item.filesAffected,
    riskLevel: item.riskLevel,
    preservedFromIteration: item.preservedFromIteration || 0
  }));
  const executionOrder = topologicalOrder(workItems).map((item) => item.workItemId);
  const orchestrationCore = {
    iteration,
    orchestrator: 'Orchestrator Agent',
    selectedAgentIds,
    selectedAgents: selectedAgentIds.map((agentId) => SPECIALIST_AGENTS[agentId].name),
    executionOrder,
    specialistSections,
    materialChangeHash: stableHash({
      targetOrgId: job.orgContext?.expectedOrgId,
      metadataScopeHash: metadataScope.hash,
      fileOperations: (plan.fileOperations || []).map(({ operation, path, content }) => ({ operation, path, contentHash: stableHash(content) })),
      dataOperations: plan.dataOperations || []
    })
  };
  const planWithoutHash = { ...plan, specialistSections, executionOrder, materialChangeHash: orchestrationCore.materialChangeHash };
  delete planWithoutHash.planHash;
  return {
    plan: { ...planWithoutHash, planHash: stableHash(planWithoutHash) },
    workItems,
    specialistMessages: messages,
    fileOwnership,
    orchestration: { ...orchestrationCore, orchestrationHash: stableHash(orchestrationCore) }
  };
}

export function approveSpecialistWorkItems(workItems, approvalId) {
  return workItems.map((item) => {
    if (![WORK_ITEM_STATUSES.PROPOSAL_COMPLETE, WORK_ITEM_STATUSES.READY, WORK_ITEM_STATUSES.WAITING_FOR_DEPENDENCY].includes(item.status)) return item;
    return { ...item, status: WORK_ITEM_STATUSES.APPROVED, approvalId, updatedAt: new Date().toISOString() };
  });
}

export function setSpecialistStatus(workItems, agentId, status, patch = {}) {
  let found = false;
  const updated = workItems.map((item) => {
    if (item.assignedSpecialistAgent !== agentId) return item;
    found = true;
    return { ...item, ...patch, status, updatedAt: new Date().toISOString() };
  });
  if (!found) throw Object.assign(new Error(`No work item is assigned to ${agentId}.`), { code: 'SPECIALIST_WORK_ITEM_MISSING' });
  return updated;
}

export function workItemForFile(workItems, path) {
  const owner = ownerForFile(path);
  const matches = workItems.filter((item) => item.assignedSpecialistAgent === owner && item.filesAffected.includes(path));
  if (matches.length !== 1) throw Object.assign(new Error(`Approved file ${path} must have exactly one owning specialist work item.`), { code: 'FILE_OWNERSHIP_CONFLICT' });
  assertSpecialistOwnsFile(owner, path);
  return matches[0];
}

export function overallSpecialistStatus(workItems) {
  if (!(workItems || []).length) return 'NOT_STARTED';
  const statuses = new Set((workItems || []).map((item) => item.status));
  if (statuses.has(WORK_ITEM_STATUSES.FAILED)) return WORK_ITEM_STATUSES.FAILED;
  if (statuses.has(WORK_ITEM_STATUSES.CHANGES_REQUIRED)) return WORK_ITEM_STATUSES.CHANGES_REQUIRED;
  if ([WORK_ITEM_STATUSES.IMPLEMENTING, WORK_ITEM_STATUSES.VALIDATING, WORK_ITEM_STATUSES.ANALYZING].some((status) => statuses.has(status))) return 'IN_PROGRESS';
  if ([WORK_ITEM_STATUSES.PENDING, WORK_ITEM_STATUSES.READY, WORK_ITEM_STATUSES.WAITING_FOR_DEPENDENCY, WORK_ITEM_STATUSES.APPROVED].some((status) => statuses.has(status))) return 'PENDING';
  if ([...(workItems || [])].every((item) => [WORK_ITEM_STATUSES.COMPLETED, WORK_ITEM_STATUSES.IMPLEMENTATION_COMPLETE].includes(item.status))) return WORK_ITEM_STATUSES.COMPLETED;
  return WORK_ITEM_STATUSES.PROPOSAL_COMPLETE;
}

export function specialistAuditEvent(job, workItem, action, result, safeMetadata = {}) {
  return {
    jobId: job.jobId,
    actor: workItem.agentName,
    jiraIssueKey: job.jiraIssueKey,
    orgRegistryId: job.orgContext?.orgRegistryId || '',
    salesforceOrgId: job.orgContext?.expectedOrgId || '',
    environment: job.orgContext?.environment || '',
    action,
    result,
    safeMetadata: {
      agentName: workItem.agentName,
      workItemId: workItem.workItemId,
      parentJobId: job.jobId,
      ...safeMetadata
    }
  };
}

export function structuredSpecialistMessage(job, senderAgent, recipientAgent, workItemId, messageType, details = {}) {
  if (!Object.values(SPECIALIST_MESSAGE_TYPES).includes(messageType)) throw new Error(`Unsupported specialist message type: ${messageType}`);
  return {
    messageId: nanoid(),
    senderAgent,
    recipientAgent,
    parentJobId: job.jobId,
    workItemId,
    messageType,
    relevantMetadata: details.relevantMetadata || [],
    requestedInformation: String(details.requestedInformation || '').slice(0, 1000),
    dependency: details.dependency || '',
    risk: details.risk || 'LOW',
    timestamp: new Date().toISOString()
  };
}

function createWorkItems(job, requirement, metadataScope, plan, selectedAgentIds, iteration) {
  const previous = new Map((job.revisionContext?.preservedWorkItems || []).map((item) => [item.assignedSpecialistAgent, item]));
  const affectedAgents = new Set(job.revisionContext?.affectedAgentIds || selectedAgentIds);
  const workItems = selectedAgentIds.map((agentId) => {
    const definition = specialistAgent(agentId);
    const existing = previous.get(agentId);
    if (existing && !affectedAgents.has(agentId)) {
      return { ...existing, iteration, preservedFromIteration: existing.iteration || iteration - 1, status: WORK_ITEM_STATUSES.COMPLETED, updatedAt: new Date().toISOString() };
    }
    const ownedMetadata = [...(metadataScope.primaryMetadata || []), ...(metadataScope.dependencies || [])].filter((component) => ownerForMetadataType(component.type) === agentId);
    const files = (plan.fileOperations || []).filter((operation) => ownerForFile(operation.path) === agentId);
    const dataOperations = agentId === SPECIALIST_AGENT_IDS.DATA ? (plan.dataOperations || []) : [];
    const workItemId = `${job.jobId}-v${iteration}-${agentId.toLowerCase().replace(/_/g, '-')}`;
    const outputs = buildSpecialistResult(definition, ownedMetadata, files, dataOperations, plan);
    outputs.workItemId = workItemId;
    return {
      workItemId,
      parentJobId: job.jobId,
      jiraIssueKey: job.jiraIssueKey,
      iteration,
      assignedSpecialistAgent: agentId,
      agentName: definition.name,
      targetSalesforceOrg: {
        orgRegistryId: job.orgContext?.orgRegistryId || '',
        organizationId: job.orgContext?.expectedOrgId || '',
        displayName: job.orgContext?.displayName || '',
        environment: job.orgContext?.environment || ''
      },
      metadataScope: ownedMetadata,
      dependencies: [],
      status: WORK_ITEM_STATUSES.PENDING,
      inputs: {
        requirementSummary: requirement.summary,
        acceptanceCriteria: requirement.acceptanceCriteria,
        inspectionChecklist: definition.inspectionChecklist
      },
      outputs,
      filesAffected: files.map((operation) => operation.path),
      validationRequirements: validationRequirements(agentId, plan),
      riskLevel: riskForAgent(agentId, plan),
      approvalId: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  });
  applyDependencies(workItems);
  for (const item of workItems) {
    item.status = item.preservedFromIteration
      ? WORK_ITEM_STATUSES.COMPLETED
      : (item.dependencies.length ? WORK_ITEM_STATUSES.WAITING_FOR_DEPENDENCY : WORK_ITEM_STATUSES.PROPOSAL_COMPLETE);
    item.outputs.completionStatus = item.status;
  }
  return workItems;
}

function buildSpecialistResult(definition, metadata, files, dataOperations, plan) {
  const proposedChanges = files.map((item) => item.reason).filter(Boolean);
  if (dataOperations.length) proposedChanges.push(...dataOperations.map((item) => item.reason));
  if (!proposedChanges.length) {
    if (definition.id === SPECIALIST_AGENT_IDS.TESTING) proposedChanges.push(...(plan.testingStrategy || []));
    else if (definition.id === SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT) proposedChanges.push(plan.validationStrategy, plan.deploymentStrategy);
    else if (definition.id === SPECIALIST_AGENT_IDS.DOCUMENTATION_EXPLANATION) proposedChanges.push('Combine all specialist findings into human-readable Salesforce and Jira summaries, then generate versioned PDF, Word, and Markdown implementation reports after deployment.');
    else proposedChanges.push(`Inspect and coordinate the ${definition.section.toLowerCase()} required by the approved plan.`);
  }
  return {
    agentName: definition.name,
    workItemId: '',
    analysisSummary: definition.role,
    existingMetadataFound: metadata,
    proposedChanges,
    componentsToCreate: files.filter((item) => item.operation === 'create').map((item) => item.path),
    componentsToModify: files.filter((item) => item.operation === 'modify').map((item) => item.path),
    componentsNotChanged: ['Metadata outside this specialist boundary'],
    dependencies: [],
    risks: riskForAgent(definition.id, plan) === 'HIGH' ? [...(plan.risks || [])] : [],
    assumptions: plan.assumptions || [],
    validationRequirements: validationRequirements(definition.id, plan),
    filesAffected: files.map((item) => item.path),
    completionStatus: WORK_ITEM_STATUSES.PENDING
  };
}

function applyDependencies(workItems) {
  const byAgent = new Map(workItems.map((item) => [item.assignedSpecialistAgent, item]));
  const add = (agentId, dependencyId) => {
    const item = byAgent.get(agentId); const dependency = byAgent.get(dependencyId);
    if (item && dependency && !item.dependencies.includes(dependency.workItemId)) item.dependencies.push(dependency.workItemId);
  };
  add(SPECIALIST_AGENT_IDS.FLOW, SPECIALIST_AGENT_IDS.OBJECT_FIELD);
  add(SPECIALIST_AGENT_IDS.APEX, SPECIALIST_AGENT_IDS.OBJECT_FIELD);
  add(SPECIALIST_AGENT_IDS.LWC, SPECIALIST_AGENT_IDS.APEX);
  add(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS, SPECIALIST_AGENT_IDS.OBJECT_FIELD);
  add(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS, SPECIALIST_AGENT_IDS.FLOW);
  add(SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS, SPECIALIST_AGENT_IDS.APEX);
  add(SPECIALIST_AGENT_IDS.UI_METADATA, SPECIALIST_AGENT_IDS.OBJECT_FIELD);
  add(SPECIALIST_AGENT_IDS.INTEGRATION, SPECIALIST_AGENT_IDS.APEX);
  const implementationItems = implementationAgentIds([...byAgent.keys()]).map((agentId) => byAgent.get(agentId)).filter(Boolean);
  for (const item of implementationItems) add(SPECIALIST_AGENT_IDS.TESTING, item.assignedSpecialistAgent);
  add(SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT, SPECIALIST_AGENT_IDS.TESTING);
  add(SPECIALIST_AGENT_IDS.DOCUMENTATION_EXPLANATION, SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT);
  for (const item of workItems) item.outputs.dependencies = [...item.dependencies];
}

function createDependencyMessages(job, workItems) {
  const byId = new Map(workItems.map((item) => [item.workItemId, item]));
  return workItems.flatMap((item) => item.dependencies.map((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return structuredSpecialistMessage(job, dependency.agentName, item.agentName, item.workItemId, SPECIALIST_MESSAGE_TYPES.DEPENDENCY_FOUND, {
      relevantMetadata: dependency.metadataScope,
      requestedInformation: `${item.agentName} must use the final approved output from ${dependency.agentName}.`,
      dependency: dependencyId,
      risk: item.riskLevel
    });
  }));
}

function createFileOwnership(plan, workItems) {
  const seen = new Set();
  return (plan.fileOperations || []).map((operation) => {
    if (seen.has(operation.path)) throw Object.assign(new Error(`Multiple proposed operations target ${operation.path}.`), { code: 'FILE_OWNERSHIP_CONFLICT' });
    seen.add(operation.path);
    const workItem = workItemForFile(workItems, operation.path);
    return {
      path: operation.path,
      owningAgent: workItem.assignedSpecialistAgent,
      workItemId: workItem.workItemId,
      lockStatus: 'PLANNED',
      baselineHash: '',
      currentHash: '',
      updatedAt: new Date().toISOString()
    };
  });
}

function validateProposedOwnership(plan, selectedAgentIds) {
  for (const operation of plan.fileOperations || []) {
    const owner = ownerForFile(operation.path);
    if (!owner) throw Object.assign(new Error(`No specialist is allowed to modify ${operation.path}.`), { code: 'UNOWNED_SPECIALIST_FILE' });
    if (!selectedAgentIds.includes(owner)) throw Object.assign(new Error(`${specialistAgent(owner).name} was not selected for ${operation.path}.`), { code: 'SPECIALIST_NOT_SELECTED' });
    assertSpecialistOwnsFile(owner, operation.path);
  }
}

function topologicalOrder(workItems) {
  const byId = new Map(workItems.map((item) => [item.workItemId, item]));
  const remaining = new Set(byId.keys());
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter((id) => byId.get(id).dependencies.every((dependency) => !remaining.has(dependency))).sort();
    if (!ready.length) throw Object.assign(new Error('Specialist dependency graph contains a cycle.'), { code: 'SPECIALIST_DEPENDENCY_CYCLE' });
    for (const id of ready) { ordered.push(byId.get(id)); remaining.delete(id); }
  }
  return ordered;
}

function validationRequirements(agentId, plan) {
  if (agentId === SPECIALIST_AGENT_IDS.TESTING) return plan.testingStrategy || [];
  if (agentId === SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT) return ['Reverify the exact org ID', 'Verify approved files and hashes', 'Run the minimal validation package', 'Require separate deployment approval'];
  if (agentId === SPECIALIST_AGENT_IDS.APEX) return ['Relevant Apex tests', 'Bulk and governor-limit scenarios', 'Security enforcement'];
  if (agentId === SPECIALIST_AGENT_IDS.LWC) return ['LWC Jest tests', 'Loading, failure, accessibility, and duplicate-submission scenarios'];
  if (agentId === SPECIALIST_AGENT_IDS.FLOW) return ['Entry criteria, positive, negative, bulk, recursion, and fault-path scenarios'];
  if (agentId === SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS) return ['Least-privilege access checks and negative permission tests'];
  if (agentId === SPECIALIST_AGENT_IDS.DATA) return ['Read-only impact checks and exact record-operation validation before separate approval'];
  return ['Task-specific metadata validation and regression checks'];
}

function riskForAgent(agentId, plan) {
  if (agentId === SPECIALIST_AGENT_IDS.DATA && (plan.dataOperations || []).length) return 'HIGH';
  if (agentId === SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS && /escalat|admin|broad/i.test((plan.risks || []).join(' '))) return 'HIGH';
  return plan.estimatedRiskLevel || 'LOW';
}
