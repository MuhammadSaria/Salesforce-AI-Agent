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
