const CHECKSUM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

export function canonicalSalesforceId(value, label = 'Salesforce ID') {
  const text = String(value || '');
  if (text !== text.trim() || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(text)) {
    throw new Error(`${label} must be a valid Salesforce ID.`);
  }
  const baseId = text.slice(0, 15);
  const canonical = `${baseId}${checksumSuffix(baseId)}`;
  if (text.length === 18 && text !== canonical) {
    throw new Error(`${label} has an invalid Salesforce ID checksum.`);
  }
  return canonical;
}

export function requireSalesforceOrgId(value, label = 'Salesforce org ID') {
  const canonical = canonicalSalesforceId(value, label);
  if (!canonical.startsWith('00D')) throw new Error(`${label} must be a Salesforce Organization ID.`);
  return canonical;
}

export function requireSalesforceUserId(value, label = 'Salesforce user ID') {
  const canonical = canonicalSalesforceId(value, label);
  if (!canonical.startsWith('005')) throw new Error(`${label} must be a Salesforce User ID.`);
  return canonical;
}

export function sameSalesforceId(left, right) {
  try {
    return canonicalSalesforceId(left) === canonicalSalesforceId(right);
  } catch {
    return false;
  }
}

function checksumSuffix(baseId) {
  let suffix = '';
  for (let chunk = 0; chunk < 3; chunk += 1) {
    let flags = 0;
    for (let offset = 0; offset < 5; offset += 1) {
      const char = baseId[(chunk * 5) + offset];
      if (char >= 'A' && char <= 'Z') flags += 1 << offset;
    }
    suffix += CHECKSUM_CHARS[flags];
  }
  return suffix;
}
