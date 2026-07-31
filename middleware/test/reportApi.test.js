import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createJobRecord, updateJob } from '../src/services/jobStore.js';
import { generateImplementationReport } from '../src/services/implementationReport.js';

test('report API enforces org isolation and returns only the requested allowlisted format', async (t) => {
  const originalRoot = config.workspaceRoot;
  const originalToken = config.apiAuthToken;
  const root = await mkdtemp(join(tmpdir(), 'providus-report-api-'));
  config.workspaceRoot = root;
  config.apiAuthToken = '';
  const jobId = `report-api-${Date.now()}`;
  const expectedOrgId = '00Dg500000E07e9EAB';
  await createJobRecord({ jobId, jiraIssueKey: 'TA-77', userId: 'test-user' });
  const job = await updateJob(jobId, {
    jira: { summary: 'Add Account Status Field' },
    requirement: { summary: 'Add Account Status Field', acceptanceCriteria: 'The field is visible to approved users.' },
    orgContext: { orgRegistryId: 'developer', customerName: 'Customer', displayName: 'Developer Org', environment: 'developer', expectedOrgId },
    plan: { planVersion: 1, requirementSummary: 'Add Account Status Field', proposedImplementation: 'Add the approved field.', expectedOutcome: 'Approved users can view the field.', fileOperations: [], dataOperations: [] },
    implementation: { implementedAt: '2026-07-15T09:00:00Z' },
    validation: { status: 'PASSED', timestamp: '2026-07-15T09:30:00Z' }
  });
  const paths = { jobRoot: join(root, 'jobs', jobId), deployment: join(root, 'jobs', jobId, 'deployment') };
  await mkdir(paths.deployment, { recursive: true });
  const deployment = { deployedAt: '2026-07-15T10:00:00Z', targetOrgId: expectedOrgId, sourceHash: 'source', packageHash: 'package', summary: 'Deployment completed.', components: [] };
  const report = await generateImplementationReport(job, deployment, paths, 1);
  await updateJob(jobId, { deployment, implementationReports: [report] });

  const server = createApp().listen(0);
  await new Promise((resolvePromise) => server.once('listening', resolvePromise));
  t.after(async () => {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    config.workspaceRoot = originalRoot;
    config.apiAuthToken = originalToken;
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'X-Agent-Org-Id': expectedOrgId, 'X-Agent-User-Id': '005-test', 'X-Agent-Role': 'developer' };
  const response = await fetch(`${base}/api/jobs/${jobId}/implementation-reports/1/pdf`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.contentType, 'application/pdf');
  assert.match(body.fileName, /\.pdf$/);
  assert.equal(Buffer.from(body.contentBase64, 'base64').subarray(0, 4).toString(), '%PDF');

  const wrongOrg = await fetch(`${base}/api/jobs/${jobId}/implementation-reports/1/pdf`, { headers: { ...headers, 'X-Agent-Org-Id': '00D000000000999' } });
  assert.equal(wrongOrg.status, 403);
  assert.equal((await fetch(`${base}/api/jobs/${jobId}/implementation-reports/1/html`, { headers })).status, 422);
  assert.equal((await fetch(`${base}/api/jobs/${jobId}/implementation-reports/2/pdf`, { headers })).status, 404);

  const publicJob = await (await fetch(`${base}/api/jobs/${jobId}`, { headers })).json();
  const serialized = JSON.stringify(publicJob.implementationReports);
  assert.doesNotMatch(serialized, /relativePath|sha256|contentBase64/);
});
