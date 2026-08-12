import { architecturePlanCore } from './architecturePlan.js';

export function assertArchitecturePlanActionable(plan) {
  if (plan && ('fileOperations' in plan || 'content' in plan || 'generatedFiles' in plan)) {
    throw actionableError('Architecture planning cannot include source generation fields.');
  }
  if (Array.isArray(plan?.evidenceIds) && !plan.evidenceIds.length) throw actionableError('Architecture plan evidence is required before approval.');
  if (Array.isArray(plan?.components) && !plan.components.length) throw actionableError('Architecture plan component scope is required before approval.');
  let core;
  try {
    core = architecturePlanCore(plan);
  } catch {
    throw actionableError('Architecture plan is not actionable.');
  }
  if (!core.evidenceIds.length) throw actionableError('Architecture plan evidence is required before approval.');
  if (!core.components.length) throw actionableError('Architecture plan component scope is required before approval.');
  return core;
}

function actionableError(message) {
  return Object.assign(new Error(message), { statusCode: 409, code: 'PLAN_NOT_ACTIONABLE' });
}
