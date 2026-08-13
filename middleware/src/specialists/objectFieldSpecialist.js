import { assertCompleteMetadataDocument, generateSpecialistSource, specialistError } from './specialistSource.js';

export function generateObjectFieldSource(request, { modelRunner } = {}) {
  return generateSpecialistSource(request, {
    specialistId: 'OBJECT_FIELD',
    metadataTypes: ['CustomField'],
    modelRunner,
    sourceFormatRequirements: [
      'Return one complete CustomField XML metadata document per approved component with no Markdown or placeholders.',
      'Use the exact approved object-qualified API name and a Number field for the installment sequence.',
      'Do not generate PermissionSet, Flow, Apex, or any unapproved metadata.'
    ],
    validateOperation(operation) {
      assertCompleteMetadataDocument(operation.content, 'CustomField');
      if (!/<type>Number<\/type>/.test(operation.content)) throw specialistError('SPECIALIST_SOURCE_INCOMPLETE', 'The installment field must be a Number CustomField.');
      const fieldName = operation.apiName.split('.').at(-1);
      if (!new RegExp(`<fullName>${escapeRegex(fieldName)}<\\/fullName>`).test(operation.content)) {
        throw specialistError('SPECIALIST_SCOPE_VIOLATION', 'CustomField source must use the exact approved API name.');
      }
      if (/<(?:PermissionSet|Flow|ApexClass)\b/.test(operation.content)) throw specialistError('SPECIALIST_OWNERSHIP_VIOLATION', 'Object/Field source contains cross-owner metadata.');
    }
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
