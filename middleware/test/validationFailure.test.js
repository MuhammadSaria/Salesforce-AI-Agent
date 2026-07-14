import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizeValidationFailure } from '../src/utils/validationFailure.js';

test('explains a Flow email recipient collection mismatch in plain language', () => {
  const result = humanizeValidationFailure('You cannot assign Recipient Address List when isCollection is true.');
  assert.match(result, /Flow email action/);
  assert.doesNotMatch(result, /isCollection/);
});

test('provides a safe fallback for an unfamiliar Salesforce validation error', () => {
  assert.equal(humanizeValidationFailure('Unexpected component failure'), 'Salesforce rejected the proposed change: Unexpected component failure');
});
