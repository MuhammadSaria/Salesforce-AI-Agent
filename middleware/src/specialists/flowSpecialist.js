import { assertCompleteMetadataDocument, generateSpecialistSource, specialistError } from './specialistSource.js';
import { validateRecurringDonationFlow } from './flowSemantics.js';

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
      const context = flowContext(request);
      validateRecurringDonationFlow(operation.content, context);
    }
  }).then((result) => {
    if (result.status === 'COMPLETED' && !result.risks.some((risk) => /concurr/i.test(risk) && /cannot guarantee strict uniqueness/i.test(risk))) {
      throw specialistError('SPECIALIST_SOURCE_INCOMPLETE', 'Flow result must record the concurrent uniqueness limitation.');
    }
    return result;
  });
}

function flowContext(request) {
  const fieldApiName = request.dependencyResults.flatMap((dependency) => dependency.operations).find((operation) => operation.metadataType === 'CustomField')?.apiName || '';
  const [objectApiName, installmentField] = fieldApiName.split('.');
  const relationship = request.inspectionEvidence.find((item) => item.kind === 'RELATIONSHIP' && item.objectApiName === objectApiName);
  const status = request.inspectionEvidence.find((item) => item.kind === 'STATUS_VALUE' && item.objectApiName === objectApiName);
  if (!objectApiName || !installmentField || !relationship || !status) throw specialistError('SPECIALIST_EVIDENCE_INVALID', 'Flow requires exact relationship, status, and installment-field evidence.');
  return { objectApiName, installmentField, relationshipField: relationship.fieldApiName, statusField: status.fieldApiName, completedValue: status.value };
}

function requiresStrictConcurrency(planContext = {}) {
  const text = [planContext.requirement, ...(planContext.acceptanceCriteria || []), ...(planContext.expectedBehavior || [])].join(' ');
  return /strict(?:ly)?\s+(?:concurrent\s+)?uniqueness|strict uniqueness|(?:unique|uniqueness).{0,80}concurr|concurr.{0,80}(?:unique|uniqueness)|guarantee(?:d)?\s+(?:strict\s+)?uniqueness/i.test(text);
}
