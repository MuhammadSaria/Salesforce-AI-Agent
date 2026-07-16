import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanActionable, evaluatePlanActionability } from '../src/domain/planActionability.js';

test('development requests with no concrete operations require more information', () => {
  const result = evaluatePlanActionability(
    { fileOperations: [], dataOperations: [], missingInformation: [] },
    { text: 'Create a screen flow for consent capture.' }
  );

  assert.equal(result.requestKind, 'DEVELOPMENT');
  assert.equal(result.actionable, false);
  assert.match(result.missingInformation.join(' '), /no salesforce source or record changes/i);
});

test('development requests are actionable when a concrete source operation exists', () => {
  const result = evaluatePlanActionability(
    { fileOperations: [{ operation: 'create', path: 'force-app/main/default/flows/Consent.flow-meta.xml' }], dataOperations: [] },
    { text: 'Create a screen flow for consent capture.' }
  );

  assert.equal(result.requestKind, 'DEVELOPMENT');
  assert.equal(result.actionable, true);
  assert.equal(result.fileOperationCount, 1);
});

test('informational requests may complete without source or record changes', () => {
  const result = evaluatePlanActionability(
    { fileOperations: [], dataOperations: [] },
    { text: 'Explain how the current consent process works.' }
  );

  assert.equal(result.requestKind, 'INFORMATIONAL');
  assert.equal(result.actionable, true);
});

test('informational requests remain informational when they mention Salesforce metadata', () => {
  const explanation = evaluatePlanActionability(
    { fileOperations: [], dataOperations: [] },
    { text: 'Explain how the current consent Flow works.' }
  );
  const requestedChange = evaluatePlanActionability(
    { fileOperations: [], dataOperations: [] },
    { text: 'Review and update the current consent Flow.' }
  );

  assert.equal(explanation.requestKind, 'INFORMATIONAL');
  assert.equal(explanation.actionable, true);
  assert.equal(requestedChange.requestKind, 'DEVELOPMENT');
  assert.equal(requestedChange.actionable, false);
});

test('failed required attachment extraction blocks an otherwise concrete plan', () => {
  const result = evaluatePlanActionability(
    { fileOperations: [{ operation: 'create', path: 'force-app/main/default/flows/Consent.flow-meta.xml' }], dataOperations: [] },
    { text: 'Implement the attached requirements.' },
    { attachmentFailures: [{ fileName: 'requirements.docx', reason: 'Unsupported or unreadable file.' }] }
  );

  assert.equal(result.actionable, false);
  assert.deepEqual(result.attachmentFailures, [{ fileName: 'requirements.docx', reason: 'Unsupported or unreadable file.' }]);
  assert.throws(() => assertPlanActionable({ ...result }), (error) => error.code === 'PLAN_NOT_ACTIONABLE' && error.statusCode === 409);
});
