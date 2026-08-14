import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVELOPMENT_JOB_STATES, assertDevelopmentTransition, publicDevelopmentStatus } from '../src/domain/developmentJob.js';

test('direct chat reaches planning without a Jira state', () => {
  assert.doesNotThrow(() => assertDevelopmentTransition('RECEIVED', 'UNDERSTANDING'));
  assert.doesNotThrow(() => assertDevelopmentTransition('UNDERSTANDING', 'INSPECTING_ORG'));
  assert.doesNotThrow(() => assertDevelopmentTransition('INSPECTING_ORG', 'PLANNING'));
});

test('implementation cannot skip approval', () => {
  assert.throws(() => assertDevelopmentTransition('PLANNING', 'IMPLEMENTING'), /Invalid job transition/);
});

test('implementation may pause for material specialist clarification', () => {
  assert.doesNotThrow(() => assertDevelopmentTransition('IMPLEMENTING', 'AWAITING_CLARIFICATION'));
});

test('states have business-readable labels', () => {
  assert.equal(publicDevelopmentStatus('AWAITING_IMPLEMENTATION_APPROVAL'), 'Plan ready for review');
  assert.equal(publicDevelopmentStatus('VALIDATING'), 'Checking the solution in Salesforce');
});

test('legacy Jira states project to Phase 1 status labels', () => {
  assert.equal(publicDevelopmentStatus('ANALYZING_JIRA'), 'Understanding the request');
  assert.equal(publicDevelopmentStatus('AWAITING_PLAN_APPROVAL'), 'Plan ready for review');
});

test('development state constants include direct-chat approval state', () => {
  assert.equal(DEVELOPMENT_JOB_STATES.AWAITING_IMPLEMENTATION_APPROVAL, 'AWAITING_IMPLEMENTATION_APPROVAL');
});
