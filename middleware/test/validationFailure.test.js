import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizeValidationFailure, normalizeValidationFailure } from '../src/utils/validationFailure.js';

test('explains a Flow email recipient collection mismatch in plain language', () => {
  const result = humanizeValidationFailure('You cannot assign Recipient Address List when isCollection is true.');
  assert.match(result, /Flow email action/);
  assert.doesNotMatch(result, /isCollection/);
});

test('provides a safe fallback for an unfamiliar Salesforce validation error', () => {
  assert.equal(humanizeValidationFailure('Unexpected component failure'), 'Salesforce rejected the proposed change: Unexpected component failure');
});

test('normalizes structured validation evidence without retaining secrets or unknown detail fields', () => {
  const normalized = normalizeValidationFailure({
    code: 'METADATA_XML_MALFORMED', source: 'SALESFORCE_VALIDATION',
    component: { metadataType: 'Flow', apiName: 'Approved', path: 'force-app/main/default/flows/Approved.flow-meta.xml' },
    details: { line: 7, message: 'Authorization: Bearer top-secret', databaseUrl: 'postgres://secret' }
  });
  assert.equal(normalized.details.line, 7);
  assert.match(normalized.details.message, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(normalized), /top-secret|postgres:\/\//);
  assert.equal(Object.hasOwn(normalized.details, 'databaseUrl'), false);
});
