import { nanoid } from 'nanoid';
import { DEVELOPMENT_JOB_STATES } from '../domain/developmentJob.js';
import { normalizeValidationFailure } from '../utils/validationFailure.js';
import {
  VALIDATION_FAILURE_CLASSES,
  classifyValidationFailure,
  createCorrectionService
} from './correctionService.js';

export function createCorrectionRouter({ jobStore, correctionService } = {}) {
  if (!jobStore) throw routingError('CORRECTION_STORE_REQUIRED', 'A durable correction JobStore is required.');
  const mechanical = correctionService || createCorrectionService({ jobStore });
  return {
    async routeValidationFailure(input = {}) {
      const classification = classifyValidationFailure(input.failure);
      if (classification === VALIDATION_FAILURE_CLASSES.MECHANICAL) {
        let current = await requiredJob(jobStore, input.job);
        if (current.status === DEVELOPMENT_JOB_STATES.VALIDATING) {
          await jobStore.transition(current.jobId, DEVELOPMENT_JOB_STATES.CORRECTING, {
            actor: input.actor || 'system',
            reason: 'Trusted mechanical validation evidence requires bounded owner correction.'
          });
          current = await jobStore.get(current.jobId);
        }
        if (current.status !== DEVELOPMENT_JOB_STATES.CORRECTING) {
          throw routingError('CORRECTION_STATE_INVALID', 'Mechanical correction requires the correcting lifecycle state.');
        }
        try {
          const result = await mechanical.correctMechanicalFailure({ ...input, job: current });
          await jobStore.transition(current.jobId, DEVELOPMENT_JOB_STATES.VALIDATING, {
            actor: input.actor || 'system',
            reason: 'Corrected complete source passed deterministic validation and requires target validation again.'
          });
          return { classification, ...result };
        } catch (error) {
          if (error?.code === 'CORRECTION_LIMIT_REACHED') {
            await jobStore.transition(current.jobId, DEVELOPMENT_JOB_STATES.FAILED, {
              actor: input.actor || 'system',
              reason: 'Mechanical correction limit reached.',
              error: 'Mechanical correction limit reached.'
            });
          }
          throw error;
        }
      }
      if (classification === VALIDATION_FAILURE_CLASSES.INFRASTRUCTURE) {
        throw infrastructureFailure(input.failure);
      }
      await routeMaterialFailure(jobStore, input);
      return { classification, status: DEVELOPMENT_JOB_STATES.AWAITING_CLARIFICATION, correctionAttemptConsumed: false, sourceWritten: false };
    }
  };
}

async function requiredJob(jobStore, job) {
  if (!job?.jobId) throw routingError('CORRECTION_JOB_REQUIRED', 'A persisted correction job is required.');
  const current = await jobStore.get(job.jobId);
  if (!current) throw routingError('CORRECTION_JOB_REQUIRED', 'A persisted correction job is required.');
  return current;
}

async function routeMaterialFailure(jobStore, { job, failure, actor = 'system' }) {
  if (!job?.jobId) throw routingError('CORRECTION_JOB_REQUIRED', 'A persisted correction job is required.');
  const normalized = normalizeValidationFailure(failure);
  await jobStore.invalidateForPlanChange(job.jobId, actor, { instruction: materialQuestion(normalized) });
  const invalidated = await jobStore.get(job.jobId);
  const clarification = {
    clarificationId: nanoid(),
    ambiguityId: `material:validation:${normalized.code.toLowerCase()}`,
    material: true,
    question: materialQuestion(normalized),
    status: 'OPEN',
    source: 'validation-correction',
    createdAt: new Date().toISOString()
  };
  await jobStore.update(job.jobId, { clarifications: [...(invalidated.clarifications || []), clarification] });
  await jobStore.transition(job.jobId, DEVELOPMENT_JOB_STATES.UNDERSTANDING, {
    actor,
    reason: 'Material validation evidence invalidated the prior implementation approval and requires replanning.'
  });
  await jobStore.transition(job.jobId, DEVELOPMENT_JOB_STATES.AWAITING_CLARIFICATION, {
    actor,
    reason: clarification.question
  });
}

function materialQuestion(failure) {
  return failure.details?.message
    || `Validation identified a material scope requirement (${failure.code}). Clarify the required behavior before replanning.`;
}

function infrastructureFailure(failure) {
  const normalized = normalizeValidationFailure(failure);
  return Object.assign(new Error('Validation infrastructure is temporarily unavailable; retry through the existing bounded worker policy.'), {
    code: normalized.code,
    statusCode: 503,
    retryable: true,
    validationFailure: normalized
  });
}

function routingError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
