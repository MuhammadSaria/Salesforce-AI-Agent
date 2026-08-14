import { nanoid } from 'nanoid';
import { SPECIALIST_RESULT_SCHEMA, SPECIALIST_STATUSES } from '../domain/specialistContract.js';
import {
  assertSpecialistOwnsFile,
  ownerForMetadataType,
  specialistIdForArchitectureOwner
} from '../domain/specialistAgents.js';
import { assertCanonicalOperationPath } from '../domain/metadataPath.js';
import { MAX_MECHANICAL_CORRECTION_ATTEMPTS, nextMechanicalCorrectionAttempt } from '../domain/developmentJob.js';
import { currentJobStore } from '../persistence/jobStore.js';
import { validateSpecialistOperations } from '../validation/sourceValidator.js';
import { stableHash } from '../utils/hash.js';
import { redactSecrets, sanitizeUntrustedText } from '../utils/sanitize.js';
import { sameSalesforceId } from '../utils/salesforceId.js';
import { normalizeValidationFailure } from '../utils/validationFailure.js';
import { componentKeysForPlan, createComponentLockService } from './componentLockService.js';
import { executeSpecialistModel } from './modelExecutor.js';

export const VALIDATION_FAILURE_CLASSES = Object.freeze({
  MECHANICAL: 'MECHANICAL',
  MATERIAL: 'MATERIAL',
  INFRASTRUCTURE: 'INFRASTRUCTURE'
});

const TRUSTED_FAILURE_SOURCES = new Set([
  'SOURCE_VALIDATION',
  'LOCAL_VALIDATION',
  'SALESFORCE_VALIDATION',
  'VALIDATION_INFRASTRUCTURE'
]);
const FAILURE_CODES = Object.freeze({
  MECHANICAL: new Set([
    'METADATA_XML_MALFORMED',
    'METADATA_XML_STRUCTURE_INVALID',
    'METADATA_XML_ELEMENT_ORDER_INVALID',
    'MANIFEST_ENTRY_MISSING',
    'SOURCE_COMPILE_SYNTAX',
    'METADATA_SYNTAX_INVALID',
    'SOURCE_FORMAT_INVALID'
  ]),
  MATERIAL: new Set([
    'UNAPPROVED_FIELD_REQUIRED',
    'NEW_COMPONENT_REQUIRED',
    'BUSINESS_BEHAVIOR_CHANGE_REQUIRED',
    'SECURITY_SCOPE_EXPANSION_REQUIRED',
    'DATA_SCOPE_EXPANSION_REQUIRED',
    'UNRELATED_DEPENDENCY_REQUIRED'
  ]),
  INFRASTRUCTURE: new Set([
    'VALIDATION_TIMEOUT',
    'SERVICE_UNAVAILABLE',
    'SALESFORCE_API_UNAVAILABLE',
    'SALESFORCE_NETWORK_ERROR',
    'CLI_UNAVAILABLE',
    'DATABASE_UNAVAILABLE',
    'QUEUE_UNAVAILABLE'
  ])
});
const MODEL_INFRASTRUCTURE_CODES = new Set([
  'SPECIALIST_MODEL_TIMEOUT',
  'SPECIALIST_MODEL_UNAVAILABLE',
  'SPECIALIST_MODEL_FAILED'
]);

export function classifyValidationFailure(failure) {
  const code = String(failure?.code || '');
  const source = String(failure?.source || '');
  if (!TRUSTED_FAILURE_SOURCES.has(source)) throw unclassified();
  for (const classification of Object.values(VALIDATION_FAILURE_CLASSES)) {
    if (FAILURE_CODES[classification].has(code)) return classification;
  }
  throw unclassified();
}

export function createCorrectionService({
  jobStore,
  modelRunner = executeSpecialistModel,
  validateOperations = validateSpecialistOperations,
  tokenFactory = nanoid
} = {}) {
  if (!jobStore) throw correctionError('CORRECTION_STORE_REQUIRED', 'A durable correction JobStore is required.');
  const locks = createComponentLockService({ jobStore });

  return {
    async correctMechanicalFailure(request = {}) {
      const { job, failure, owner, lockToken } = request;
      assertMechanicalRequest(job, failure, request.attempt);
      if (!job?.jobId) throw correctionError('CORRECTION_JOB_REQUIRED', 'A persisted correction job is required.');

      const persisted = await jobStore.get(job.jobId);
      if (!persisted) throw correctionError('CORRECTION_JOB_REQUIRED', 'A persisted correction job is required.');
      const binding = correctionBinding(persisted);
      assertSnapshotBinding(job, persisted, binding);
      const operations = completeStoredOperations(persisted);
      const target = resolveFailedOperation(persisted, operations, failure);
      if (owner !== target.owner) throw correctionError('CORRECTION_OWNER_MISMATCH', 'Correction owner does not match trusted operation ownership.');
      const componentKeys = componentKeysForPlan(persisted.plan);
      await locks.assertComponentLocksOwned({ jobId: persisted.jobId, componentKeys, lockToken });

      const reservation = await reserveAttempt({
        jobStore,
        jobId: persisted.jobId,
        requestedAttempt: request.attempt,
        owner: target.owner,
        failure,
        binding,
        tokenFactory
      });
      const input = correctionModelInput(persisted, failure, target);
      let rawResult;
      try {
        rawResult = await modelRunner(input);
      } catch (error) {
        if (MODEL_INFRASTRUCTURE_CODES.has(error?.code)) {
          await clearReservation(jobStore, persisted.jobId, reservation.token);
          throw correctionError(error.code, 'Correction model infrastructure is unavailable.');
        }
        await consumeFailedAttempt({ locks, persisted, componentKeys, lockToken, reservation, failure, error, binding });
        throw safeCorrectionFailure(error);
      }

      let correctedSubset;
      let validated;
      try {
        correctedSubset = parseCorrectionResult(rawResult, target);
        const combined = replaceOperations(operations, correctedSubset);
        const ownership = ownershipForOperations(persisted, combined);
        await locks.assertComponentLocksOwned({ jobId: persisted.jobId, componentKeys, lockToken });
        validated = validateOperations({ operations: combined, plan: persisted.plan, ownership, inspection: persisted.inspection });
      } catch (error) {
        await consumeFailedAttempt({ locks, persisted, componentKeys, lockToken, reservation, failure, error, binding });
        throw safeCorrectionFailure(error);
      }

      const sourceValidation = sourceValidationBinding(persisted, validated);
      const result = await locks.updateWithComponentLocks({ jobId: persisted.jobId, componentKeys, lockToken }, (record) => {
        assertReservation(record, reservation);
        assertCurrentBinding(record, binding);
        const currentOperations = completeStoredOperations(record);
        const nextOperations = replaceOperations(currentOperations, correctedSubset);
        if (stableHash(nextOperations) !== sourceValidation.sourceHash) {
          throw correctionError('CORRECTION_SOURCE_STALE', 'Corrected source changed before it could be persisted.');
        }
        const specialistResult = record.specialistResults[target.owner];
        const replacements = new Map(correctedSubset.map((operation) => [operation.path, operation]));
        record.specialistResults = {
          ...record.specialistResults,
          [target.owner]: {
            ...specialistResult,
            operations: specialistResult.operations.map((operation) => replacements.get(operation.path) || operation),
            correctedAt: new Date().toISOString()
          }
        };
        record.correctionAttempt = reservation.attempt;
        record.correctionReservation = null;
        record.correctionHistory = appendHistory(record.correctionHistory, {
          attempt: reservation.attempt,
          owner: target.owner,
          status: 'PASSED',
          failure: normalizeValidationFailure(failure),
          previousSourceHash: record.sourceValidation?.sourceHash || '',
          sourceHash: sourceValidation.sourceHash,
          correctedPaths: correctedSubset.map((operation) => operation.path),
          timestamp: new Date().toISOString()
        });
        record.sourceValidation = sourceValidation;
        record.validation = null;
        return {
          attempt: reservation.attempt,
          owner: target.owner,
          operations: validated.operations,
          sourceValidation,
          sourceWritten: false
        };
      });
      await locks.assertComponentLocksOwned({ jobId: persisted.jobId, componentKeys, lockToken });
      return result;
    }
  };
}

export async function correctMechanicalFailure(request = {}, options = {}) {
  assertMechanicalRequest(request.job, request.failure, request.attempt);
  const jobStore = options.jobStore || currentJobStore();
  return createCorrectionService({ ...options, jobStore }).correctMechanicalFailure(request);
}

function assertMechanicalRequest(job, failure, attempt) {
  if (classifyValidationFailure(failure) !== VALIDATION_FAILURE_CLASSES.MECHANICAL) {
    throw correctionError('MECHANICAL_CORRECTION_NOT_ALLOWED', 'Only trusted mechanical failures may enter correction.');
  }
  const persistedAttempt = Number(job?.correctionAttempt || 0);
  const requestedAttempt = Number(attempt);
  if (persistedAttempt >= MAX_MECHANICAL_CORRECTION_ATTEMPTS || requestedAttempt > MAX_MECHANICAL_CORRECTION_ATTEMPTS) {
    throw correctionError('CORRECTION_LIMIT_REACHED', 'Mechanical correction is limited to three cycles.');
  }
  if (!Number.isInteger(requestedAttempt) || requestedAttempt < 1) {
    throw correctionError('CORRECTION_ATTEMPT_INVALID', 'Correction attempt is invalid.');
  }
}

async function reserveAttempt({ jobStore, jobId, requestedAttempt, owner, failure, binding, tokenFactory }) {
  return jobStore.updateAtomically(jobId, (record) => {
    assertCurrentBinding(record, binding);
    if (record.correctionReservation) throw correctionError('CORRECTION_IN_PROGRESS', 'A correction attempt is already reserved.');
    const attempt = nextMechanicalCorrectionAttempt(record, requestedAttempt);
    const reservation = {
      token: tokenFactory(), attempt, owner,
      failureHash: stableHash(normalizeValidationFailure(failure)),
      reservedAt: new Date().toISOString()
    };
    record.correctionReservation = reservation;
    return reservation;
  });
}

async function clearReservation(jobStore, jobId, token) {
  await jobStore.updateAtomically(jobId, (record) => {
    if (record.correctionReservation?.token === token) record.correctionReservation = null;
  });
}

async function consumeFailedAttempt({ locks, persisted, componentKeys, lockToken, reservation, failure, error, binding }) {
  await locks.updateWithComponentLocks({ jobId: persisted.jobId, componentKeys, lockToken }, (record) => {
    assertReservation(record, reservation);
    assertCurrentBinding(record, binding);
    record.correctionAttempt = reservation.attempt;
    record.correctionReservation = null;
    record.correctionHistory = appendHistory(record.correctionHistory, {
      attempt: reservation.attempt,
      owner: reservation.owner,
      status: 'FAILED',
      failure: normalizeValidationFailure(failure),
      errorCode: safeErrorCode(error),
      correctedPaths: [],
      timestamp: new Date().toISOString()
    });
  });
}

function parseCorrectionResult(value, target) {
  const parsed = SPECIALIST_RESULT_SCHEMA.safeParse(value);
  if (!parsed.success) throw correctionError('CORRECTION_RESULT_INVALID', 'Correction model returned an invalid structured result.');
  if (parsed.data.status !== SPECIALIST_STATUSES.COMPLETED) {
    throw correctionError('CORRECTION_MATERIAL_REQUIRED', 'Correction model reported a material requirement.');
  }
  if (parsed.data.operations.length !== target.operations.length) {
    throw correctionError('CORRECTION_SCOPE_VIOLATION', 'Correction result does not contain the exact failed operation set.');
  }
  const expected = new Map(target.operations.map((operation) => [operation.path, operation]));
  for (const operation of parsed.data.operations) {
    try { assertCanonicalOperationPath(operation); } catch { throw correctionError('CORRECTION_SCOPE_VIOLATION', 'Correction result path is not canonical.'); }
    if (ownerForMetadataType(operation.metadataType) !== target.owner) {
      throw correctionError('CORRECTION_OWNER_MISMATCH', 'Correction result crosses specialist ownership.');
    }
    try { assertSpecialistOwnsFile(target.owner, operation.path); } catch { throw correctionError('CORRECTION_OWNER_MISMATCH', 'Correction result crosses specialist ownership.'); }
    const original = expected.get(operation.path);
    if (!original
      || operation.operation !== original.operation
      || operation.metadataType !== original.metadataType
      || operation.apiName !== original.apiName) {
      throw correctionError('CORRECTION_SCOPE_VIOLATION', 'Correction result changed an approved operation identity.');
    }
  }
  return parsed.data.operations;
}

function resolveFailedOperation(job, operations, failure) {
  const component = failure?.component || {};
  const operation = operations.find((candidate) =>
    candidate.path === component.path
    && candidate.metadataType === component.metadataType
    && candidate.apiName === component.apiName
  );
  if (!operation) throw correctionError('CORRECTION_SCOPE_VIOLATION', 'Failure is not bound to an approved operation.');
  const result = Object.values(job.specialistResults || {}).find((candidate) =>
    (candidate.operations || []).some((item) => item.path === operation.path)
  );
  const owner = result?.specialistId || '';
  if (!owner || ownerForMetadataType(operation.metadataType) !== owner) {
    throw correctionError('CORRECTION_OWNER_MISMATCH', 'Failed operation does not have one trusted specialist owner.');
  }
  return { owner, operations: [operation] };
}

function correctionModelInput(job, failure, target) {
  const approvedComponents = (job.plan.components || [])
    .map((component) => ({ ...component, owner: specialistIdForArchitectureOwner(component.owner) || component.owner }))
    .filter((component) => target.operations.some((operation) => sameComponent(operation, component)))
    .map((component) => ({ ...component, owner: target.owner }));
  const approvedEvidence = new Set(job.plan.evidenceIds || []);
  const trustedEvidence = (job.inspection.evidence || [])
    .filter((evidence) => approvedEvidence.has(evidence.evidenceId))
    .filter((evidence) => evidenceRelevantToOwner(evidence, target.owner, target.operations))
    .map((evidence) => ({ ...evidence, ...(Object.hasOwn(evidence, 'retrievedSource') ? { retrievedSource: sanitizeUntrustedText(evidence.retrievedSource, 500000) } : {}) }));
  return {
    specialistId: target.owner,
    failure: normalizeValidationFailure(failure),
    originalApprovedBehavior: {
      requirement: sanitizeUntrustedText(job.plan.requirement, 8000),
      acceptanceCriteria: sanitizeArray(job.plan.acceptanceCriteria, 25, 1000),
      expectedBehavior: sanitizeArray(job.plan.expectedBehavior, 30, 1000),
      risks: sanitizeArray(job.plan.risks, 30, 1000)
    },
    currentFiles: target.operations.map((operation) => ({ ...operation })),
    ownership: target.operations.map((operation) => ({ path: operation.path, owner: target.owner })),
    approvedComponents,
    trustedContext: {
      sourceOrgId: job.plan.trustedBinding.sourceOrgId,
      inspectionHash: job.inspection.hash,
      planVersion: Number(job.plan.planVersion),
      evidence: trustedEvidence
    }
  };
}

function correctionBinding(job) {
  const baseline = job?.implementationBaseline;
  const plan = job?.plan;
  const sourceOrgId = plan?.trustedBinding?.sourceOrgId;
  const componentKeys = componentKeysForPlan(plan);
  if (job?.status !== 'CORRECTING'
    || baseline?.status !== 'CAPTURED'
    || baseline.sourceWritten !== false
    || !/^[a-f0-9]{7,64}$/i.test(String(baseline.baselineCommit || ''))
    || baseline.planHash !== plan?.planHash
    || baseline.scopeHash !== plan?.scopeHash
    || baseline.inspectionHash !== job?.inspection?.hash
    || stableHash(baseline.componentKeys || []) !== stableHash(componentKeys)
    || !sameSalesforceId(baseline.sourceOrgId, sourceOrgId)
    || !sameSalesforceId(sourceOrgId, job?.orgContext?.expectedOrgId)
    || !sameSalesforceId(sourceOrgId, job?.orgId)
    || job?.sourceValidation?.status !== 'PASSED'
    || job.sourceValidation.planHash !== plan?.planHash
    || job.sourceValidation.scopeHash !== plan?.scopeHash
    || job.sourceValidation.inspectionHash !== job?.inspection?.hash
    || !sameSalesforceId(job.sourceValidation.sourceOrgId, sourceOrgId)) {
    throw correctionError('CORRECTION_BASELINE_STALE', 'Correction is not bound to the current immutable exact-org baseline.');
  }
  return {
    planHash: plan.planHash,
    scopeHash: plan.scopeHash,
    inspectionHash: job.inspection.hash,
    sourceOrgId,
    planVersion: Number(plan.planVersion),
    approvedComponentsHash: stableHash(plan.components),
    baselineHash: stableHash(baseline),
    currentSourceHash: job.sourceValidation.sourceHash,
    sourceValidationHash: stableHash(job.sourceValidation)
  };
}

function assertSnapshotBinding(snapshot, current, binding) {
  if (snapshot?.plan?.planHash !== binding.planHash
    || snapshot?.plan?.scopeHash !== binding.scopeHash
    || snapshot?.inspection?.hash !== binding.inspectionHash
    || Number(snapshot?.plan?.planVersion) !== binding.planVersion
    || stableHash(snapshot?.plan?.components) !== binding.approvedComponentsHash
    || stableHash(snapshot?.implementationBaseline) !== binding.baselineHash
    || snapshot?.sourceValidation?.sourceHash !== binding.currentSourceHash
    || stableHash(snapshot?.sourceValidation) !== binding.sourceValidationHash
    || !sameSalesforceId(snapshot?.orgId, current?.orgId)) {
    throw correctionError('CORRECTION_BASELINE_STALE', 'Correction request contains stale trusted authority.');
  }
}

function assertCurrentBinding(record, binding) {
  if (record?.plan?.planHash !== binding.planHash
    || record?.plan?.scopeHash !== binding.scopeHash
    || record?.inspection?.hash !== binding.inspectionHash
    || Number(record?.plan?.planVersion) !== binding.planVersion
    || stableHash(record?.plan?.components) !== binding.approvedComponentsHash
    || stableHash(record?.implementationBaseline) !== binding.baselineHash
    || record?.sourceValidation?.sourceHash !== binding.currentSourceHash
    || stableHash(record?.sourceValidation) !== binding.sourceValidationHash
    || !sameSalesforceId(record?.plan?.trustedBinding?.sourceOrgId, binding.sourceOrgId)) {
    throw correctionError('CORRECTION_BASELINE_STALE', 'Correction authority changed during the correction cycle.');
  }
}

function completeStoredOperations(job) {
  const operations = Object.values(job?.specialistResults || {}).flatMap((result) => result?.operations || []);
  operations.sort((left, right) => `${left.operation}:${left.metadataType}:${left.apiName}`.localeCompare(`${right.operation}:${right.metadataType}:${right.apiName}`, 'en-US'));
  const sourceValidation = job?.sourceValidation;
  if (!operations.length
    || stableHash(operations) !== sourceValidation?.sourceHash
    || Number(sourceValidation?.operationCount) !== operations.length
    || stableHash(sourceValidation?.validatedPaths || []) !== stableHash(operations.map((operation) => operation.path))) {
    throw correctionError('CORRECTION_SOURCE_STALE', 'Current specialist source is not bound to Task 9 validation.');
  }
  return operations;
}

function ownershipForOperations(job, operations) {
  const ownership = {};
  for (const operation of operations) {
    const result = Object.values(job.specialistResults || {}).find((candidate) =>
      (candidate.operations || []).some((item) => item.path === operation.path)
    );
    if (!result?.specialistId || ownership[operation.path]) {
      throw correctionError('CORRECTION_OWNER_MISMATCH', 'Complete source does not have unique trusted ownership.');
    }
    ownership[operation.path] = result.specialistId;
  }
  return ownership;
}

function replaceOperations(operations, replacements) {
  const byPath = new Map(replacements.map((operation) => [operation.path, operation]));
  return operations.map((operation) => byPath.get(operation.path) || operation);
}

function sourceValidationBinding(job, validated) {
  return {
    status: 'PASSED',
    sourceHash: validated.sourceHash,
    operationCount: validated.operations.length,
    validatedPaths: validated.operations.map((operation) => operation.path),
    sourceOrgId: job.plan.trustedBinding.sourceOrgId,
    inspectionHash: job.inspection.hash,
    planHash: job.plan.planHash,
    scopeHash: job.plan.scopeHash,
    validatedAt: new Date().toISOString()
  };
}

function assertReservation(record, reservation) {
  if (record.correctionReservation?.token !== reservation.token
    || Number(record.correctionReservation?.attempt) !== reservation.attempt) {
    throw correctionError('CORRECTION_RESERVATION_LOST', 'Correction attempt reservation was lost.');
  }
}

function evidenceRelevantToOwner(evidence, owner, operations) {
  const apiNames = new Set(operations.map((operation) => operation.apiName));
  if (apiNames.has(evidence.componentApiName || evidence.apiName || '')) return true;
  if (owner === 'FLOW') return ['RELATIONSHIP', 'STATUS_VALUE'].includes(evidence.kind);
  if (owner === 'OBJECT_FIELD') return ['OBJECT', 'FIELD', 'RELATIONSHIP'].includes(evidence.kind);
  return false;
}

function sameComponent(left, right) {
  return left.operation === right.operation && left.metadataType === right.metadataType && left.apiName === right.apiName;
}

function sanitizeArray(values, maxItems, maxLength) {
  return (Array.isArray(values) ? values : []).slice(0, maxItems).map((value) => sanitizeUntrustedText(value, maxLength));
}

function appendHistory(history, item) {
  return [...(Array.isArray(history) ? history : []), item].slice(-MAX_MECHANICAL_CORRECTION_ATTEMPTS);
}

function safeErrorCode(error) {
  const code = String(error?.code || 'CORRECTION_FAILED');
  return /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : 'CORRECTION_FAILED';
}

function safeCorrectionFailure(error) {
  if (/^[A-Z][A-Z0-9_]{0,99}$/.test(String(error?.code || ''))) return error;
  return correctionError('CORRECTION_FAILED', redactSecrets('Corrected source did not pass deterministic validation.'));
}

function unclassified() {
  return correctionError('VALIDATION_FAILURE_UNCLASSIFIED', 'Validation failure evidence is unknown or ambiguous.');
}

function correctionError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
