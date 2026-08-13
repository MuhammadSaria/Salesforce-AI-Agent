import { assertCompleteMetadataDocument, generateSpecialistSource, specialistError } from './specialistSource.js';

const REQUIRED_SEMANTICS = Object.freeze([
  'CREATE_AS_COMPLETED',
  'TRANSITION_TO_COMPLETED',
  'ALREADY_NUMBERED_PROTECTION',
  'SAME_PARENT_LOOKUP',
  'FIRST_INSTALLMENT_ONE',
  'INCREMENT_N_PLUS_ONE',
  'REVERSAL_RETENTION',
  'NO_HISTORICAL_RENUMBER',
  'NO_OVERWRITE'
]);

export async function generateFlowSource(request, { modelRunner } = {}) {
  const strictConcurrency = requiresStrictConcurrency(request?.planContext);
  const blockedResult = strictConcurrency ? {
    status: 'BLOCKED',
    operations: [],
    dependencies: ['OBJECT_FIELD', 'SECURITY_PERMISSIONS'],
    risks: ['Strict concurrent uniqueness cannot be guaranteed by a highest-existing-number plus one Flow design.'],
    verification: ['No Flow or Apex source was generated or written.'],
    materialQuestion: 'Strict concurrent uniqueness cannot be guaranteed by this Flow design. Do you want to expand the approved scope to a locking-capable Apex implementation?'
  } : null;
  return generateSpecialistSource(request, {
    specialistId: 'FLOW',
    metadataTypes: ['Flow'],
    modelRunner,
    blockedResult,
    sourceFormatRequirements: [
      'Return one complete Flow XML metadata document per approved component with no Markdown or placeholders.',
      'The Flow must contain exactly <status>Draft</status>; Active is prohibited.',
      `Represent and document these required semantics in the XML: ${REQUIRED_SEMANTICS.join(', ')}.`,
      'Scope highest-number lookup to the same recurring parent; assign 1 when none exists and otherwise N + 1.',
      'Never overwrite, clear, or historically renumber an existing installment number.',
      'Record that highest-plus-one Flow numbering cannot guarantee strict uniqueness under concurrent processing.',
      strictConcurrency ? 'Return BLOCKED with no operations and ask whether scope should expand to locking-capable Apex.' : 'Generate sequential best-effort numbering only.'
    ],
    validateOperation(operation) {
      assertCompleteMetadataDocument(operation.content, 'Flow');
      if (/<status>Active<\/status>/.test(operation.content)) throw specialistError('FLOW_MUST_BE_INACTIVE', 'Generated Flow source must not be Active.');
      const statuses = [...operation.content.matchAll(/<status>([^<]+)<\/status>/g)].map((match) => match[1]);
      if (statuses.length !== 1 || statuses[0] !== 'Draft') throw specialistError('FLOW_MUST_BE_INACTIVE', 'Generated Flow source must contain exactly one Draft status.');
      if (/<(?:PermissionSet|CustomField|ApexClass)\b/.test(operation.content)) throw specialistError('SPECIALIST_OWNERSHIP_VIOLATION', 'Flow source contains cross-owner metadata.');
      const missing = REQUIRED_SEMANTICS.filter((semantic) => !operation.content.includes(semantic));
      if (missing.length) throw specialistError('SPECIALIST_SOURCE_INCOMPLETE', `Flow source is missing approved semantics: ${missing.join(', ')}.`);
      const missingSource = missingExecutableSemantics(operation.content, request);
      if (missingSource.length) throw specialistError('SPECIALIST_SOURCE_INCOMPLETE', `Flow source is missing required generation structure: ${missingSource.join(', ')}.`);
    }
  }).then((result) => {
    if (result.status === 'COMPLETED' && !result.risks.some((risk) => /concurr/i.test(risk) && /cannot guarantee strict uniqueness/i.test(risk))) {
      throw specialistError('SPECIALIST_SOURCE_INCOMPLETE', 'Flow result must record the concurrent uniqueness limitation.');
    }
    return result;
  });
}

function requiresStrictConcurrency(planContext = {}) {
  const text = [planContext.requirement, ...(planContext.acceptanceCriteria || []), ...(planContext.expectedBehavior || [])].join(' ');
  return /strict(?:ly)?\s+(?:concurrent\s+)?uniqueness|strict uniqueness|(?:unique|uniqueness).{0,80}concurr|concurr.{0,80}(?:unique|uniqueness)|guarantee(?:d)?\s+(?:strict\s+)?uniqueness/i.test(text);
}

function missingExecutableSemantics(content, request) {
  const missing = [];
  const fieldApiName = request.dependencyResults
    .filter((dependency) => dependency.specialistId === 'OBJECT_FIELD')
    .flatMap((dependency) => dependency.operations)
    .find((operation) => operation.metadataType === 'CustomField')?.apiName || '';
  const [objectApiName, installmentField] = fieldApiName.split('.');
  const relationshipField = request.inspectionEvidence.find((evidence) => evidence.kind === 'RELATIONSHIP' && evidence.objectApiName === objectApiName)?.fieldApiName || '';
  const statusEvidence = request.inspectionEvidence.find((evidence) => evidence.kind === 'STATUS_VALUE' && evidence.objectApiName === objectApiName);
  const statusField = statusEvidence?.fieldApiName || '';
  const completedValue = statusEvidence?.value || '';
  if (!objectApiName || !installmentField || !relationshipField || !statusField || !completedValue) missing.push('confirmed API-name evidence');

  const start = tagBlock(content, 'start');
  if (!start || !hasTag(start, 'object', objectApiName) || !hasTag(start, 'recordTriggerType', 'CreateAndUpdate') || !hasTag(start, 'triggerType', 'RecordBeforeSave') || !hasTag(start, 'doesRequireRecordChangedToMeetCriteria', 'true') || !/<connector>/.test(start)) missing.push('record-triggered create/update start');
  if (!hasFilter(start, statusField, 'EqualTo', `<stringValue>${escapeRegex(completedValue)}</stringValue>`)) missing.push('completed-status entry criterion');
  if (!hasFilter(start, installmentField, 'IsNull', '<booleanValue>true</booleanValue>')) missing.push('non-overwrite entry criterion');

  const lookups = tagBlocks(content, 'recordLookups');
  const highest = lookups.find((block) => hasTag(block, 'object', objectApiName) && hasTag(block, 'sortField', installmentField) && hasTag(block, 'sortOrder', 'Desc') && hasTag(block, 'getFirstRecordOnly', 'true')) || '';
  if (!highest || !hasFilter(highest, relationshipField, 'EqualTo', `<elementReference>\\$Record\\.${escapeRegex(relationshipField)}</elementReference>`) || !hasFilter(highest, installmentField, 'IsNull', '<booleanValue>false</booleanValue>') || !/<connector>/.test(highest)) missing.push('same-parent highest-number lookup');

  const formula = tagBlocks(content, 'formulas').find((block) => new RegExp(`<expression>[^<]*${escapeRegex(installmentField)}[^<]*\\+\\s*1<\\/expression>`).test(block)) || '';
  if (!formula) missing.push('N plus one formula');
  const formulaName = tagValue(formula, 'name');
  const assignments = tagBlocks(content, 'assignments');
  const first = assignments.some((block) => hasTag(block, 'assignToReference', `$Record.${installmentField}`) && /<numberValue>1(?:\.0+)?<\/numberValue>/.test(block));
  const increment = assignments.some((block) => hasTag(block, 'assignToReference', `$Record.${installmentField}`) && formulaName && hasTag(block, 'elementReference', formulaName));
  if (!first) missing.push('first installment assignment');
  if (!increment) missing.push('increment assignment');
  const decision = tagBlocks(content, 'decisions').some((block) => new RegExp(`<leftValueReference>[^<]*${escapeRegex(installmentField)}|<leftValueReference>[^<]*\\.Id`).test(block) && /<connector>/.test(block) && /<defaultConnector>/.test(block));
  if (!decision) missing.push('first-versus-increment decision');
  return [...new Set(missing)];
}

function tagBlocks(content, tag) {
  return [...content.matchAll(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g'))].map((match) => match[0]);
}

function tagBlock(content, tag) {
  return tagBlocks(content, tag)[0] || '';
}

function tagValue(content, tag) {
  return content.match(new RegExp(`<${tag}>([^<]+)<\\/${tag}>`))?.[1] || '';
}

function hasTag(content, tag, value) {
  return new RegExp(`<${tag}>${escapeRegex(value)}<\\/${tag}>`).test(content);
}

function hasFilter(content, field, operator, valuePattern) {
  if (!field) return false;
  return tagBlocks(content, 'filters').some((filter) => hasTag(filter, 'field', field) && hasTag(filter, 'operator', operator) && new RegExp(valuePattern).test(filter));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
