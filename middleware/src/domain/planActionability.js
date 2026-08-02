import { architecturePlanCore } from './architecturePlan.js';

export function assertArchitecturePlanActionable(plan) {
  if (plan && ('fileOperations' in plan || 'content' in plan || 'generatedFiles' in plan)) {
    throw actionableError('Architecture planning cannot include source generation fields.');
  }
  const core = architecturePlanCore(plan);
  if (!core.evidenceIds.length) throw actionableError('Architecture plan evidence is required before approval.');
  if (!core.components.length) throw actionableError('Architecture plan component scope is required before approval.');
  return core;
}

function actionableError(message) {
  return Object.assign(new Error(message), { statusCode: 409, code: 'PLAN_NOT_ACTIONABLE' });
}

