import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, JOB_STATES } from '../src/domain/jobState.js';

test('safe job lifecycle accepts the required supervised flow', () => {
  const flow = [JOB_STATES.RECEIVED, JOB_STATES.VERIFYING_ORG, JOB_STATES.ANALYZING_JIRA, JOB_STATES.DISCOVERING_METADATA, JOB_STATES.RETRIEVING_RELEVANT_METADATA, JOB_STATES.ANALYZING_DEPENDENCIES, JOB_STATES.AWAITING_PLAN_APPROVAL, JOB_STATES.IMPLEMENTING, JOB_STATES.VALIDATING, JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL, JOB_STATES.DEPLOYING, JOB_STATES.COMPLETED];
  for (let index = 1; index < flow.length; index += 1) assert.doesNotThrow(() => assertTransition(flow[index - 1], flow[index]));
});

test('invalid transition cannot bypass implementation and deployment approvals', () => {
  assert.throws(() => assertTransition(JOB_STATES.RECEIVED, JOB_STATES.DEPLOYING), /Invalid job transition/);
  assert.throws(() => assertTransition(JOB_STATES.AWAITING_PLAN_APPROVAL, JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL), /Invalid job transition/);
});

test('a validated no-change plan can complete without deployment', () => {
  assert.doesNotThrow(() => assertTransition(JOB_STATES.VALIDATING, JOB_STATES.COMPLETED));
});

test('incomplete requirements block approval until revised analysis is requested', () => {
  assert.doesNotThrow(() => assertTransition(JOB_STATES.ANALYZING_DEPENDENCIES, JOB_STATES.AWAITING_REQUIREMENTS));
  assert.doesNotThrow(() => assertTransition(JOB_STATES.AWAITING_REQUIREMENTS, JOB_STATES.ANALYZING_JIRA));
  assert.throws(() => assertTransition(JOB_STATES.AWAITING_REQUIREMENTS, JOB_STATES.IMPLEMENTING), /Invalid job transition/);
});
