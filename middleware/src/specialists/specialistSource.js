import { SPECIALIST_REQUEST_SCHEMA, SPECIALIST_RESULT_SCHEMA } from '../domain/specialistContract.js';
import { config } from '../config.js';

const MAX_SPECIALIST_MODEL_INPUT_BYTES = 1000000;

export async function generateSpecialistSource(request, options) {
  const parsedRequest = SPECIALIST_REQUEST_SCHEMA.parse(request);
  if (parsedRequest.specialistId !== options.specialistId) {
    throw specialistError('SPECIALIST_REQUEST_MISMATCH', `${options.specialistId} cannot execute a ${parsedRequest.specialistId} request.`);
  }
  if (typeof options.modelRunner !== 'function') {
    throw specialistError('SPECIALIST_MODEL_UNAVAILABLE', `No structured model runner is configured for ${options.specialistId}.`);
  }
  const modelInput = boundedModelInput(parsedRequest, options);
  const modelInputBytes = Buffer.byteLength(JSON.stringify(modelInput), 'utf8');
  if (modelInputBytes > Math.min(config.maxMetadataSizeBytes, MAX_SPECIALIST_MODEL_INPUT_BYTES)) {
    throw specialistError('SPECIALIST_MODEL_INPUT_TOO_LARGE', 'Bounded specialist model input exceeds the configured aggregate size limit.');
  }
  let rawResult;
  try {
    rawResult = await options.modelRunner(modelInput);
  } catch (error) {
    if (options.blockedResult) return options.blockedResult;
    throw error;
  }
  if (options.blockedResult) return options.blockedResult;
  let result;
  try {
    result = SPECIALIST_RESULT_SCHEMA.parse(rawResult);
  } catch (cause) {
    throw Object.assign(specialistError('SPECIALIST_RESULT_SCHEMA_INVALID', `Invalid ${options.specialistId} specialist result.`), { cause });
  }
  if (result.status === 'BLOCKED') return result;
  assertOperationsMatchApproval(parsedRequest, result, options);
  return result;
}

export function assertCompleteMetadataDocument(content, rootElement) {
  const text = String(content || '').trim();
  const unsafe = !text
    || /```|\bTODO\b|rest omitted|placeholder/i.test(text)
    || !/^<\?xml\s+version=["']1\.0["'][^>]*>/.test(text)
    || !new RegExp(`<${rootElement}\\s+xmlns=["']http:\\/\\/soap\\.sforce\\.com\\/2006\\/04\\/metadata["'][^>]*>`).test(text)
    || !new RegExp(`</${rootElement}>\\s*$`).test(text);
  if (unsafe) throw specialistError('SPECIALIST_SOURCE_INCOMPLETE', `The ${rootElement} source must be one complete raw Salesforce metadata document.`);
}

export function specialistError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function boundedModelInput(request, options) {
  return {
    specialistId: options.specialistId,
    ownedApprovedComponents: request.approvedComponents,
    requirement: request.planContext.requirement,
    acceptanceCriteria: request.planContext.acceptanceCriteria,
    expectedBehavior: request.planContext.expectedBehavior,
    risks: request.planContext.risks,
    inspectionEvidence: request.inspectionEvidence.map(safeEvidence),
    confirmedApiNames: request.approvedComponents.map((component) => component.apiName),
    dependencyResults: request.dependencyResults,
    sourceFormatRequirements: options.sourceFormatRequirements
  };
}

function safeEvidence(evidence) {
  const allowed = ['evidenceId', 'kind', 'metadataType', 'apiName', 'componentType', 'componentApiName', 'objectApiName', 'fieldApiName', 'targetObjectApiName', 'value', 'active', 'stale', 'retrievedSource'];
  if (typeof evidence.retrievedSource === 'string' && Buffer.byteLength(evidence.retrievedSource, 'utf8') > 500000) {
    throw specialistError('SPECIALIST_MODEL_INPUT_TOO_LARGE', 'Retrieved specialist source exceeds the per-document size limit.');
  }
  return Object.fromEntries(allowed.filter((key) => evidence[key] !== undefined).map((key) => [key, evidence[key]]));
}

function assertOperationsMatchApproval(request, result, options) {
  if (result.operations.length !== request.approvedComponents.length) {
    throw specialistError('SPECIALIST_SCOPE_VIOLATION', `${options.specialistId} must generate exactly its approved components.`);
  }
  const approved = new Set(request.approvedComponents.map(componentKey));
  for (const operation of result.operations) {
    if (!options.metadataTypes.includes(operation.metadataType)) {
      throw specialistError('SPECIALIST_OWNERSHIP_VIOLATION', `${options.specialistId} cannot generate ${operation.metadataType}.`);
    }
    if (!approved.has(componentKey(operation))) {
      throw specialistError('SPECIALIST_SCOPE_VIOLATION', `${options.specialistId} returned unapproved ${operation.metadataType} ${operation.apiName}.`);
    }
    options.validateOperation(operation, request);
  }
}

function componentKey(component) {
  return `${component.operation}:${component.metadataType}:${component.apiName}`;
}
