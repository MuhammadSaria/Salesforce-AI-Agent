import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateJobSummaries, publicJobSummary } from '../src/services/jobPresentation.js';

function record(index) {
  return {
    jobId: `job-${String(index).padStart(3, '0')}`,
    jiraIssueKey: `TA-${index + 1}`,
    source: 'jira',
    status: index % 2 ? 'COMPLETED' : 'AWAITING_PLAN_APPROVAL',
    currentActivity: 'Reviewing',
    jira: { summary: `Ticket ${index}`, description: 'large description', attachmentContents: [{ text: 'large attachment' }] },
    orgContext: { displayName: 'Providus Developer Org', customerName: 'Providus', environment: 'developer', expectedOrgId: '00DTEST' },
    plan: { planVersion: 2, proposedImplementation: 'large plan', fileOperations: [{ content: 'large source' }] },
    logs: [{ message: 'large log' }],
    audit: [{ action: 'large audit' }],
    diff: 'large diff',
    workItems: [],
    createdAt: new Date(Date.UTC(2026, 6, 16, 0, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 6, 16, 1, 0, index)).toISOString()
  };
}

test('job summaries contain selector data but exclude heavy and private artifacts', () => {
  const summary = publicJobSummary(record(1));
  assert.equal(summary.jobId, 'job-001');
  assert.equal(summary.jiraSummary, 'Ticket 1');
  assert.equal(summary.targetOrgDisplayName, 'Providus Developer Org');
  for (const key of ['jira', 'plan', 'logs', 'audit', 'diff', 'workItems', 'attachmentContents']) assert.equal(key in summary, false, key);
});

test('job summaries suppress stale activity after analysis has finished', () => {
  const completed = publicJobSummary(record(1));
  const analyzing = publicJobSummary({ ...record(1), status: 'ANALYZING_DEPENDENCIES', currentActivity: 'Preparing implementation plan' });

  assert.equal(completed.currentActivity, '');
  assert.equal(analyzing.currentActivity, 'Preparing implementation plan');
});

test('job summary pagination is stable and bounded', () => {
  const records = Array.from({ length: 75 }, (_, index) => record(index));
  const first = paginateJobSummaries(records, { limit: 25 });
  const second = paginateJobSummaries(records, { limit: 25, cursor: first.nextCursor });

  assert.equal(first.jobs.length, 25);
  assert.equal(second.jobs.length, 25);
  assert.equal(first.total, 75);
  assert.notEqual(first.jobs[24].jobId, second.jobs[0].jobId);
  assert.ok(first.nextCursor);
});

test('job summary page size is capped at 100', () => {
  const page = paginateJobSummaries(Array.from({ length: 150 }, (_, index) => record(index)), { limit: 1000 });
  assert.equal(page.jobs.length, 100);
});
