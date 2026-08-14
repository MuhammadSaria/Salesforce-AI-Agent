const API_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:__c)?$/;
const FIELD_API_NAME = /^([A-Za-z][A-Za-z0-9_]*(?:__c)?)\.([A-Za-z][A-Za-z0-9_]*(?:__(?:c|pc)|Id)?)$/;

const TYPE_PATHS = Object.freeze({
  PermissionSet: ['permissionsets', '.permissionset-meta.xml'],
  PermissionSetGroup: ['permissionsetgroups', '.permissionsetgroup-meta.xml'],
  MutingPermissionSet: ['mutingpermissionsets', '.mutingpermissionset-meta.xml'],
  Profile: ['profiles', '.profile-meta.xml'],
  CustomPermission: ['customPermissions', '.customPermission-meta.xml'],
  Flow: ['flows', '.flow-meta.xml']
});

export function canonicalMetadataPath(metadataType, apiName) {
  if (metadataType === 'CustomField') {
    const match = String(apiName || '').match(FIELD_API_NAME);
    if (!match) throw pathError('CustomField API name must be ObjectApi.FieldApi.');
    return `force-app/main/default/objects/${match[1]}/fields/${match[2]}.field-meta.xml`;
  }
  const mapping = TYPE_PATHS[metadataType];
  if (!mapping || !API_NAME.test(String(apiName || ''))) throw pathError(`Unsupported or invalid metadata component ${metadataType}:${apiName}.`);
  return `force-app/main/default/${mapping[0]}/${apiName}${mapping[1]}`;
}

export function assertCanonicalOperationPath(operation) {
  const raw = String(operation?.path || '');
  assertSafeRawPath(raw);
  const expected = canonicalMetadataPath(operation.metadataType, operation.apiName);
  if (raw !== expected || raw.normalize('NFC') !== raw) throw pathError(`Specialist path must exactly match trusted component path ${expected}.`);
  return expected;
}

function assertSafeRawPath(path) {
  if (!path || path.includes('\0') || /[\x00-\x1f\x7f]/.test(path) || /\\|%[0-9a-f]{2}|^[A-Za-z]:|^\/|^\\\\|^[a-z][a-z0-9+.-]*:/i.test(path)) throw pathError('Unsafe specialist metadata path.');
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..') || path !== segments.join('/')) throw pathError('Unsafe specialist metadata path segments.');
  if (!path.startsWith('force-app/main/default/')) throw pathError('Specialist metadata path must remain under force-app/main/default.');
}

function pathError(message) {
  return Object.assign(new Error(message), { code: 'SPECIALIST_PATH_VIOLATION', statusCode: 409 });
}
