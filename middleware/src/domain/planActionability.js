const DEVELOPMENT_PATTERN = /\b(create|add|build|implement|modify|update|delete|remove|deploy|configure|migrate|backfill|insert|upsert|flow|apex|trigger|lwc|lightning|field|object|report|dashboard|permission|layout|integration|record|metadata)\b/i;
const MUTATION_PATTERN = /\b(create|add|build|implement|modify|update|delete|remove|deploy|configure|migrate|backfill|insert|upsert)\b/i;
const INFORMATION_PATTERN = /^\s*(explain|describe|review|investigate|analy[sz]e|summari[sz]e|what|why|how|where|when|which|can you tell)\b/i;

export function classifyRequestKind(requirement = {}) {
  const text = requirementText(requirement);
  if (INFORMATION_PATTERN.test(text) && !MUTATION_PATTERN.test(text)) return 'INFORMATIONAL';
  if (DEVELOPMENT_PATTERN.test(text)) return 'DEVELOPMENT';
  if (INFORMATION_PATTERN.test(text)) return 'INFORMATIONAL';
  return 'DEVELOPMENT';
}

export function evaluatePlanActionability(plan = {}, requirement = {}, jira = {}) {
  const requestKind = classifyRequestKind(requirement);
  const fileOperationCount = Array.isArray(plan.fileOperations) ? plan.fileOperations.length : 0;
  const dataOperationCount = Array.isArray(plan.dataOperations) ? plan.dataOperations.length : 0;
  const attachmentFailures = Array.isArray(jira?.attachmentFailures) ? jira.attachmentFailures : [];
  const missingInformation = unique([
    ...(Array.isArray(plan.missingInformation) ? plan.missingInformation : []),
    ...attachmentFailures.map((failure) => `Could not read ${failure.fileName || 'a Jira attachment'}: ${failure.reason || 'unknown error'}`)
  ]);

  let actionable = requestKind === 'INFORMATIONAL' || fileOperationCount + dataOperationCount > 0;
  if (attachmentFailures.length) actionable = false;
  if (!actionable && requestKind === 'DEVELOPMENT') {
    missingInformation.push('No Salesforce source or record changes were proposed for this development request. Add the missing implementation details or fix requirement extraction before approval.');
  }

  return {
    requestKind,
    actionable,
    missingInformation: unique(missingInformation),
    attachmentFailures,
    fileOperationCount,
    dataOperationCount
  };
}

export function assertPlanActionable(planOrActionability, requirement, jira) {
  const result = typeof planOrActionability?.actionable === 'boolean' && requirement === undefined
    ? planOrActionability
    : evaluatePlanActionability(planOrActionability, requirement, jira);
  if (result.actionable) return result;
  const error = new Error(result.missingInformation?.[0] || 'The implementation plan is not actionable.');
  error.statusCode = 409;
  error.code = 'PLAN_NOT_ACTIONABLE';
  error.details = result;
  throw error;
}

function requirementText(requirement) {
  if (typeof requirement === 'string') return requirement;
  return [
    requirement?.text,
    requirement?.summary,
    requirement?.businessRequirement,
    requirement?.acceptanceCriteria,
    ...(Array.isArray(requirement?.userInstructions) ? requirement.userInstructions : [])
  ].filter(Boolean).join('\n');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
