import { SPECIALIST_AGENT_IDS, WORK_ITEM_STATUSES, implementationAgentIds } from '../domain/specialistAgents.js';

const REVIEW_AGENT_IDS = [
  SPECIALIST_AGENT_IDS.TESTING,
  SPECIALIST_AGENT_IDS.VALIDATION_DEPLOYMENT,
  SPECIALIST_AGENT_IDS.DOCUMENTATION_EXPLANATION
];

export function preservableCompletedWorkItems(job, affectedAgentIds = new Set()) {
  const affected = affectedAgentIds instanceof Set ? affectedAgentIds : new Set(affectedAgentIds || []);
  const changedFiles = new Set(job?.implementation?.changedFiles || []);
  const dataOperationCount = (job?.plan?.dataOperations || []).length;
  return (job?.workItems || []).filter((item) => {
    if (item.status !== WORK_ITEM_STATUSES.COMPLETED || affected.has(item.assignedSpecialistAgent)) return false;
    if (REVIEW_AGENT_IDS.includes(item.assignedSpecialistAgent)) return false;
    const evidence = item.implementationEvidence;
    if (evidence?.completedAt && ((evidence.filePaths || []).length || evidence.dataOperationCount > 0)) return true;
    if ((item.filesAffected || []).some((path) => changedFiles.has(path))) return true;
    return item.assignedSpecialistAgent === SPECIALIST_AGENT_IDS.DATA && dataOperationCount > 0 && Boolean(job?.implementation);
  });
}

export function routeValidationCorrection(job, errorMessage) {
  const message = String(errorMessage || '').replace(/\\/g, '/');
  const implementationItems = (job?.workItems || []).filter((item) => implementationAgentIds([item.assignedSpecialistAgent]).length);
  let matched = implementationItems.filter((item) => (item.filesAffected || []).some((path) => message.includes(String(path).replace(/\\/g, '/'))));
  if (!matched.length) {
    matched = implementationItems.filter((item) => (item.filesAffected || []).length || (item.assignedSpecialistAgent === SPECIALIST_AGENT_IDS.DATA && (job?.plan?.dataOperations || []).length));
  }
  if (!matched.length) matched = implementationItems;
  const implementationOwners = [...new Set(matched.map((item) => item.assignedSpecialistAgent))];
  return {
    implementationAgentIds: implementationOwners,
    affectedAgentIds: [...new Set([...implementationOwners, ...REVIEW_AGENT_IDS])],
    workItemIds: matched.map((item) => item.workItemId),
    reason: message.slice(0, 2000),
    createdAt: new Date().toISOString()
  };
}
