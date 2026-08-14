import { assertCompleteMetadataDocument, generateSpecialistSource, specialistError } from './specialistSource.js';

export function generateSecuritySource(request, { modelRunner } = {}) {
  return generateSpecialistSource(request, {
    specialistId: 'SECURITY_PERMISSIONS',
    metadataTypes: ['PermissionSet', 'PermissionSetGroup', 'MutingPermissionSet', 'Profile', 'CustomPermission'],
    modelRunner,
    sourceFormatRequirements: [
      'Return one complete permission metadata document per approved component with no Markdown or placeholders.',
      'Grant only exact approved field access from permitted OBJECT_FIELD dependency results.',
      'Do not invent object, system, Apex, application, Flow, or unrelated field access.'
    ],
    validateOperation(operation, parsedRequest) {
      const root = operation.metadataType;
      const xml = assertCompleteMetadataDocument(operation.content, root);
      if (/<(?:Flow|CustomField|ApexClass)\b/.test(operation.content)) throw specialistError('SPECIALIST_OWNERSHIP_VIOLATION', 'Security source contains cross-owner metadata.');
      if (/<(?:objectPermissions|userPermissions|classAccesses|applicationVisibilities|flowAccesses)>/.test(operation.content)) {
        throw specialistError('SPECIALIST_SCOPE_VIOLATION', 'Security source expands permissions beyond approved field access.');
      }
      const approvedFields = new Set(parsedRequest.dependencyResults
        .filter((dependency) => dependency.specialistId === 'OBJECT_FIELD')
        .flatMap((dependency) => dependency.operations)
        .filter((item) => item.metadataType === 'CustomField')
        .map((item) => item.apiName));
      const generatedFields = xml.children(xml.root, 'fieldPermissions').map((node) => xml.text(node, 'field'));
      if (!generatedFields.length || generatedFields.some((field) => !approvedFields.has(field))) {
        throw specialistError('SPECIALIST_SCOPE_VIOLATION', 'Security source contains missing or unapproved field access.');
      }
      if (xml.children(xml.root, 'fieldPermissions').some((node) => xml.text(node, 'readable') !== 'true' || !['true', 'false'].includes(xml.text(node, 'editable')))) {
        throw specialistError('SPECIALIST_SOURCE_INCOMPLETE', 'Security field access must explicitly declare readable and approved editability values.');
      }
    }
  });
}
