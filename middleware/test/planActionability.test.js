import test from 'node:test';
import assert from 'node:assert/strict';
import { assertArchitecturePlanActionable } from '../src/domain/planActionability.js';

test('actionability rejects source-generation fields and empty planning evidence', () => {
  assert.throws(
    () => assertArchitecturePlanActionable({ ...validPlan(), evidenceIds: [] }),
    /evidence/i
  );
  assert.throws(
    () => assertArchitecturePlanActionable({ ...validPlan(), fileOperations: [] }),
    /source generation/i
  );
});

test('actionability rejects empty component scope', () => {
  assert.throws(
    () => assertArchitecturePlanActionable({ ...validPlan(), components: [] }),
    /component/i
  );
});

function validPlan() {
  return {
    requirement: 'Create a recurring donation installment Flow.',
    acceptanceCriteria: ['Only paid donations are numbered.'],
    assumptions: [],
    evidenceIds: ['evidence:relationship'],
    components: [{ operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Implement the requested behavior.' }],
    expectedBehavior: ['Paid donations are numbered.'],
    testingStrategy: ['Validate the Flow in the verified sandbox.'],
    risks: [],
    rollbackStrategy: 'Do not deploy the generated metadata.'
  };
}
