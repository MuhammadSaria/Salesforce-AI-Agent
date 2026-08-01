import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, JOB_STATES } from '../src/domain/jobState.js';

test('safe job lifecycle accepts the required supervised flow', () => {
  const flow = [JOB_STATES.RECEIVED, JOB_STATES.VERIFYING_ORG, JOB_STATES.ANALYZING_JIRA, JOB_STATES.DISCOVERING_METADATA, JOB_STATES.RETRIEVING_RELEVANT_METADATA, JOB_STATES.ANALYZING_DEPENDENCIES, JOB_STATES.AWAITING_PLAN_APPROVAL, JOB_STATES.IMPLEMENTING, JOB_STATES.VALIDATING, JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL, JOB_STATES.DEPLOYING, JOB_STATES.COMPLETED];
  for (let index = 1; index < flow.length; index += 1) assert.doesNotThrow(() => assertTransition(flow[index - 1], flow[index], { source: 'jira-webhook', jiraIssueKey: 'TA-1' }));
});

test('active job transition model accepts the direct-chat planning flow', () => {
  const flow = [JOB_STATES.RECEIVED, JOB_STATES.UNDERSTANDING, JOB_STATES.INSPECTING_ORG, JOB_STATES.PLANNING, JOB_STATES.AWAITING_IMPLEMENTATION_APPROVAL, JOB_STATES.IMPLEMENTING];
  for (let index = 1; index < flow.length; index += 1) assert.doesNotThrow(() => assertTransition(flow[index - 1], flow[index], { source: 'salesforce-chat' }));
});

test('invalid transition cannot bypass implementation and deployment approvals', () => {
  assert.throws(() => assertTransition(JOB_STATES.RECEIVED, JOB_STATES.DEPLOYING, { source: 'salesforce-chat' }), /Invalid job transition/);
  assert.throws(() => assertTransition(JOB_STATES.PLANNING, JOB_STATES.IMPLEMENTING, { source: 'salesforce-chat' }), /Invalid job transition/);
  assert.throws(() => assertTransition(JOB_STATES.ANALYZING_DEPENDENCIES, JOB_STATES.IMPLEMENTING, { source: 'jira-webhook', jiraIssueKey: 'TA-1' }), /Invalid job transition/);
  assert.throws(() => assertTransition(JOB_STATES.AWAITING_PLAN_APPROVAL, JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL, { source: 'jira-webhook', jiraIssueKey: 'TA-1' }), /Invalid job transition/);
});

test('only an explicitly identified legacy job can complete validation without deployment', () => {
  assert.doesNotThrow(() => assertTransition(JOB_STATES.VALIDATING, JOB_STATES.COMPLETED, { source: 'jira-webhook', jiraIssueKey: 'TA-1' }));
  assert.throws(() => assertTransition(JOB_STATES.VALIDATING, JOB_STATES.COMPLETED, { source: 'salesforce-chat' }), /Invalid job transition/);
});
