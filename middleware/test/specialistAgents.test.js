import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE1_IMPLEMENTATION_SPECIALIST_IDS,
  SPECIALIST_AGENT_IDS,
  specialistIdForArchitectureOwner
} from '../src/domain/specialistAgents.js';

test('maps source-free architecture owners to bounded Phase 1 specialist IDs', () => {
  assert.deepEqual(PHASE1_IMPLEMENTATION_SPECIALIST_IDS, [
    SPECIALIST_AGENT_IDS.OBJECT_FIELD,
    SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS,
    SPECIALIST_AGENT_IDS.FLOW
  ]);
  assert.equal(specialistIdForArchitectureOwner('object-field-specialist'), SPECIALIST_AGENT_IDS.OBJECT_FIELD);
  assert.equal(specialistIdForArchitectureOwner('security-specialist'), SPECIALIST_AGENT_IDS.SECURITY_PERMISSIONS);
  assert.equal(specialistIdForArchitectureOwner('flow-specialist'), SPECIALIST_AGENT_IDS.FLOW);
  assert.equal(specialistIdForArchitectureOwner('untrusted-owner'), '');
});
