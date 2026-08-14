import { sanitizeUntrustedText } from './sanitize.js';
import { canonicalMetadataPath } from '../domain/metadataPath.js';

const SALESFORCE_FAILURE_CODES = Object.freeze({
  XML_PARSER_ERROR: 'METADATA_XML_MALFORMED',
  XML_PARSE_ERROR: 'METADATA_XML_MALFORMED',
  XML_STRUCTURE_ERROR: 'METADATA_XML_STRUCTURE_INVALID',
  XML_ELEMENT_ORDER: 'METADATA_XML_ELEMENT_ORDER_INVALID',
  COMPILE_ERROR: 'SOURCE_COMPILE_SYNTAX',
  MISSING_MANIFEST_ENTRY: 'MANIFEST_ENTRY_MISSING',
  MISSING_BUSINESS_FIELD: 'UNAPPROVED_FIELD_REQUIRED',
  NEW_COMPONENT_REQUIRED: 'NEW_COMPONENT_REQUIRED',
  SECURITY_SCOPE_EXPANSION_REQUIRED: 'SECURITY_SCOPE_EXPANSION_REQUIRED',
  DATA_SCOPE_EXPANSION_REQUIRED: 'DATA_SCOPE_EXPANSION_REQUIRED'
});

const SALESFORCE_INFRASTRUCTURE_CODES = Object.freeze({
  REQUEST_TIMEOUT: 'VALIDATION_TIMEOUT',
  ETIMEDOUT: 'VALIDATION_TIMEOUT',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  ECONNRESET: 'SALESFORCE_NETWORK_ERROR',
  ENOTFOUND: 'SALESFORCE_NETWORK_ERROR'
});

export function structuredSalesforceValidationFailure(result) {
  const parsed = safeJson(result?.stdout);
  const infrastructureType = String(parsed?.name || parsed?.errorCode || '');
  if (SALESFORCE_INFRASTRUCTURE_CODES[infrastructureType]) {
    return normalizeValidationFailure({
      code: SALESFORCE_INFRASTRUCTURE_CODES[infrastructureType],
      source: 'VALIDATION_INFRASTRUCTURE',
      details: { validator: 'salesforce-cli' }
    });
  }
  const details = parsed?.result?.details || parsed?.details || {};
  const failures = Array.isArray(details.componentFailures)
    ? details.componentFailures
    : details.componentFailures ? [details.componentFailures] : [];
  const failure = failures[0] || {};
  const failureType = String(failure.errorCode || failure.problemType || '');
  const code = SALESFORCE_FAILURE_CODES[failureType] || 'SALESFORCE_VALIDATION_UNCLASSIFIED';
  return normalizeValidationFailure({
    code,
    source: 'SALESFORCE_VALIDATION',
    component: salesforceComponent(failure),
    details: {
      message: failure.problem || failure.message || '',
      line: Number.isInteger(failure.lineNumber) ? failure.lineNumber : undefined,
      column: Number.isInteger(failure.columnNumber) ? failure.columnNumber : undefined,
      validator: 'salesforce-metadata-api'
    }
  });
}

export function normalizeValidationFailure(failure) {
  const component = failure?.component;
  const details = failure?.details || {};
  return {
    code: String(failure?.code || '').slice(0, 100),
    source: String(failure?.source || '').slice(0, 100),
    ...(component ? { component: {
      metadataType: String(component.metadataType || '').slice(0, 100),
      apiName: String(component.apiName || '').slice(0, 255),
      path: String(component.path || '').slice(0, 500)
    } } : {}),
    details: {
      ...(Number.isInteger(details.line) ? { line: details.line } : {}),
      ...(Number.isInteger(details.column) ? { column: details.column } : {}),
      ...(details.location ? { location: sanitizeUntrustedText(details.location, 500) } : {}),
      ...(details.validator ? { validator: sanitizeUntrustedText(details.validator, 100) } : {}),
      ...(details.message ? { message: sanitizeUntrustedText(details.message, 1000) } : {})
    }
  };
}

export function humanizeValidationFailure(value) {
  const message = String(value || '').replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
  if (!message) return 'Salesforce did not accept the proposed change. Review the implementation and run validation again.';
  if (/Recipient Address List/i.test(message) && /isCollection.*true/i.test(message)) {
    return 'The Flow email action received a list of email addresses in a format that Salesforce does not accept. The recipient must be supplied in the format required by the Salesforce email action.';
  }
  if (/duplicate value|duplicate.*found|already exists/i.test(message)) {
    return 'Salesforce found a component or value that already exists with the same identity. The implementation must reuse it or choose a unique name.';
  }
  if (/invalid field|no customfield named|not found.*field|unknown field/i.test(message)) {
    return 'The implementation references a Salesforce field that does not exist or is not available in the selected org.';
  }
  if (/insufficient access|not permitted|permission|authorization/i.test(message)) {
    return 'The connected Salesforce user does not have permission to validate one or more parts of the proposed change.';
  }
  if (/code coverage/i.test(message)) {
    return 'The Apex tests did not meet Salesforce code-coverage requirements. Tests or implementation coverage must be improved before deployment.';
  }
  if (/test.*fail|fail.*test/i.test(message)) {
    return 'One or more Salesforce tests failed. The failing behavior must be corrected before deployment can be approved.';
  }
  if (/timed out|timeout/i.test(message)) {
    return 'Salesforce validation did not finish within the allowed time. The validation must be run again with sufficient processing time.';
  }
  if (/xml|parse|markup/i.test(message)) {
    return 'Salesforce could not read part of the generated metadata because its structure or format is invalid.';
  }
  return `Salesforce rejected the proposed change: ${message.slice(0, 700)}`;
}

function salesforceComponent(failure) {
  const metadataType = String(failure.componentType || '');
  const apiName = String(failure.fullName || '');
  if (!metadataType || !apiName) return undefined;
  try {
    return { metadataType, apiName, path: canonicalMetadataPath(metadataType, apiName) };
  } catch {
    return undefined;
  }
}

function safeJson(value) {
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}
