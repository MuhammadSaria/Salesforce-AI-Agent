import test from 'node:test';
import assert from 'node:assert/strict';
import { sfFailureMessage } from '../src/services/agent.js';
import { structuredSalesforceValidationFailure } from '../src/utils/validationFailure.js';
import { classifyValidationFailure } from '../src/services/correctionService.js';

test('Salesforce component failures take precedence over CLI warnings', () => {
  const result = {
    stderr: 'Warning: optional CLI plugin could not be loaded',
    stdout: JSON.stringify({
      result: {
        details: {
          componentFailures: [{ problem: 'Screen must allow either Back or Finish.' }]
        }
      }
    })
  };

  assert.equal(sfFailureMessage(result), 'Screen must allow either Back or Finish.');
});

test('uses stable Salesforce failure type and component identity for mechanical classification', () => {
  const failure = structuredSalesforceValidationFailure({
    stdout: JSON.stringify({ result: { details: { componentFailures: [{
      problemType: 'XML_PARSER_ERROR', componentType: 'Flow', fullName: 'Assign_Installment',
      problem: 'Authorization: Bearer top-secret'
    }] } } })
  });
  assert.equal(classifyValidationFailure(failure), 'MECHANICAL');
  assert.equal(failure.component.path, 'force-app/main/default/flows/Assign_Installment.flow-meta.xml');
  assert.match(failure.details.message, /\[REDACTED\]/);
});

test('unknown Salesforce failure types remain unclassified even when free-form text says malformed XML', () => {
  const failure = structuredSalesforceValidationFailure({
    stdout: JSON.stringify({ result: { details: { componentFailures: [{
      problemType: 'Error', componentType: 'Flow', fullName: 'Assign_Installment', problem: 'malformed XML'
    }] } } })
  });
  assert.equal(failure.code, 'SALESFORCE_VALIDATION_UNCLASSIFIED');
  assert.throws(() => classifyValidationFailure(failure), (error) => error.code === 'VALIDATION_FAILURE_UNCLASSIFIED');
});

test('uses stable CLI timeout identity for infrastructure classification without free-form logs', () => {
  const failure = structuredSalesforceValidationFailure({ stdout: JSON.stringify({ name: 'REQUEST_TIMEOUT' }), stderr: 'environment dump' });
  assert.equal(classifyValidationFailure(failure), 'INFRASTRUCTURE');
  assert.equal(failure.code, 'VALIDATION_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(failure), /environment dump/);
});
