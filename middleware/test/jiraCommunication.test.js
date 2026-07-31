import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JIRA_COMMENT_INTENTS,
  classifyJiraComment,
  fallbackJiraReply,
  isProvidusNexusComment,
  jiraLifecycleComment,
  prepareProvidusNexusComment
} from '../src/services/jiraCommunication.js';

test('Providus Nexus recognizes requirement changes, constraints, bugs, and questions', () => {
  assert.deepEqual(classifyJiraComment('Can we also update the Contact Layout?'), {
    intent: JIRA_COMMENT_INTENTS.CHANGE_REQUEST,
    requiresPlanRevision: true,
    text: 'Can we also update the Contact Layout?'
  });
  assert.equal(classifyJiraComment("Please don't modify Apex.").intent, JIRA_COMMENT_INTENTS.CONSTRAINT);
  assert.equal(classifyJiraComment('The Flow is still failing.').intent, JIRA_COMMENT_INTENTS.BUG_REPORT);
  assert.equal(classifyJiraComment('Will this affect Production?').intent, JIRA_COMMENT_INTENTS.ENVIRONMENT_QUESTION);
  assert.equal(classifyJiraComment("Can you explain why you're changing the Flow?").intent, JIRA_COMMENT_INTENTS.EXPLANATION_REQUEST);
  assert.equal(classifyJiraComment('Can we deploy tomorrow?').intent, JIRA_COMMENT_INTENTS.DEPLOYMENT_SCHEDULING);
  assert.equal(classifyJiraComment('Thank you.').intent, JIRA_COMMENT_INTENTS.SOCIAL);
  assert.equal(classifyJiraComment('What happens when the Contact is updated?').requiresPlanRevision, false);
});

test('questions receive contextual replies without reopening the plan', () => {
  const sandbox = { orgContext: { environment: 'sandbox' }, plan: { expectedOutcome: 'Contacts display the approved donor status.' } };
  const productionQuestion = classifyJiraComment('Will this affect Production?');
  const reply = fallbackJiraReply(sandbox, productionQuestion);
  assert.match(reply, /approved Sandbox environment/i);
  assert.match(reply, /Nothing will be deployed to Production/i);
  assert.equal(productionQuestion.requiresPlanRevision, false);
});

test('Jira comments use the Providus Nexus identity and remove internal details', () => {
  const comment = prepareProvidusNexusComment([
    'AI agent job private-job-id completed.',
    'Job ID: private-job-id',
    'Plan Version: 4',
    'Validation ID: validation-secret',
    'Deployment ID: 0Afg500000BsObkCAF',
    'Source Hash: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'Please review the Salesforce AI Agent.'
  ].join('\n'));
  assert.match(comment, /^Providus Nexus:/);
  assert.doesNotMatch(comment, /AI agent job|private-job-id|Plan Version|Validation ID|Deployment ID|0Afg500000BsObkCAF|Source Hash/i);
  assert.match(comment, /Salesforce AI Agent/);
  assert.equal(isProvidusNexusComment(comment), true);
});

test('lifecycle comments remain short and avoid audit identifiers', () => {
  for (const stage of ['ASSIGNED', 'PLAN_READY', 'IMPLEMENTING', 'VALIDATING', 'VALIDATION_PASSED', 'VALIDATION_FAILED', 'DEPLOYMENT_COMPLETED', 'DEPLOYMENT_FAILED', 'NO_CHANGES_REQUIRED']) {
    const comment = prepareProvidusNexusComment(jiraLifecycleComment(stage));
    assert.ok(comment.length < 500);
    assert.doesNotMatch(comment, /Job ID|Plan Version|Validation ID|Deployment ID|Metadata Scope|Source Hash|Git Commit Hash|Risk Level/i);
  }
});

