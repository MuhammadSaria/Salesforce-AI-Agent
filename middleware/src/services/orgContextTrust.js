const trustedContexts = new WeakSet();

export function trustOrgContext(context) {
  if (context && typeof context === 'object') trustedContexts.add(context);
  return context;
}

export function isTrustedOrgContext(context) {
  return Boolean(context && typeof context === 'object' && trustedContexts.has(context));
}

export function assertTrustedOrgContext(context) {
  if (!isTrustedOrgContext(context)) {
    const error = new Error('A trusted Salesforce org context produced by same-org resolution is required.');
    error.code = 'UNTRUSTED_ORG_CONTEXT';
    throw error;
  }
}
