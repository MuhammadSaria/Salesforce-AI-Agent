import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { config } from '../src/config.js';
import {
  buildImplementationReportModel,
  generateImplementationReport,
  publicImplementationReport,
  readImplementationReportArtifact,
  renderImplementationMarkdown
} from '../src/services/implementationReport.js';

function fixtureJob() {
  return {
    jobId: 'report-test-job',
    jiraIssueKey: 'TA-42',
    createdAt: '2026-07-15T08:00:00.000Z',
    jira: { summary: 'Improve Donation Notifications' },
    requirement: { summary: 'Improve Donation Notifications', acceptanceCriteria: 'A qualifying donation sends one notification.' },
    orgContext: { customerName: 'Providus Technology', displayName: 'Providus Developer Org', environment: 'developer', expectedOrgId: '00DSECRET' },
    instructions: [{ text: 'Do not create duplicate automation.' }],
    implementation: { implementedAt: '2026-07-15T09:00:00.000Z' },
    validation: { status: 'PASSED', timestamp: '2026-07-15T09:30:00.000Z', validationId: 'validation-secret' },
    plan: {
      planVersion: 3,
      requirementSummary: 'Improve Donation Notifications',
      proposedImplementation: 'Update the existing donation flow instead of creating duplicate automation.',
      expectedOutcome: 'Qualifying donations send one notification without duplication.',
      businessImpact: 'Reduce duplicate emails and improve the accuracy of donor communications.',
      existingRelevantMetadata: [{ type: 'Flow', apiName: 'Donation_Notification_Flow' }],
      fileOperations: [
        { operation: 'modify', metadataType: 'Flow', apiName: 'Donation_Notification_Flow', path: 'force-app/main/default/flows/Donation_Notification_Flow.flow-meta.xml' },
        { operation: 'create', metadataType: 'CustomField', apiName: 'Donation__c.Notification_Sent__c', path: 'force-app/main/default/objects/Donation__c/fields/Notification_Sent__c.field-meta.xml' }
      ],
      dataOperations: []
    }
  };
}

function fixtureDeployment() {
  return {
    deployedAt: '2026-07-15T10:00:00.000Z',
    targetOrgId: '00DSECRET',
    sourceHash: 'source-secret-hash',
    packageHash: 'package-secret-hash',
    deploymentId: 'deployment-secret',
    summary: 'Deployed 2 Salesforce metadata components successfully.',
    components: [
      { displayName: 'Flow', apiName: 'Donation_Notification_Flow', briefInfo: 'Deployed successfully' },
      { displayName: 'CustomField', apiName: 'Donation__c.Notification_Sent__c', briefInfo: 'Deployed successfully' }
    ]
  };
}

test('builds a consultant-quality report with all required sections and no internal identifiers', () => {
  const model = buildImplementationReportModel(fixtureJob(), fixtureDeployment(), { deploymentVersion: 1, generatedAt: '2026-07-15T10:01:00.000Z' });
  const markdown = renderImplementationMarkdown(model);
  for (let section = 1; section <= 12; section += 1) assert.match(markdown, new RegExp(`## ${section}\\.`));
  assert.match(markdown, /Providus Nexus/);
  assert.match(markdown, /Donation Notification Flow/);
  assert.match(markdown, /Existing Functionality Reused/);
  assert.doesNotMatch(markdown, /00DSECRET|validation-secret|deployment-secret|source-secret-hash|package-secret-hash|force-app|<Flow>/);
});

test('generates immutable Markdown, Word, and PDF artifacts and verifies them before download', async () => {
  const originalWorkspaceRoot = config.workspaceRoot;
  const root = await mkdtemp(join(tmpdir(), 'providus-report-'));
  config.workspaceRoot = root;
  const job = fixtureJob();
  const jobRoot = join(root, 'jobs', job.jobId);
  const paths = { jobRoot, deployment: join(jobRoot, 'deployment') };
  await mkdir(paths.deployment, { recursive: true });
  try {
    const report = await generateImplementationReport(job, fixtureDeployment(), paths, 1);
    assert.equal(report.status, 'READY');
    assert.deepEqual(Object.keys(report.formats).sort(), ['docx', 'markdown', 'pdf']);

    const markdown = await readImplementationReportArtifact({ ...job, implementationReports: [report] }, 1, 'markdown');
    const docx = await readImplementationReportArtifact({ ...job, implementationReports: [report] }, 1, 'docx');
    const pdf = await readImplementationReportArtifact({ ...job, implementationReports: [report] }, 1, 'pdf');
    assert.match(markdown.buffer.toString('utf8'), /## 12\. Appendix/);
    assert.equal(docx.buffer.subarray(0, 2).toString(), 'PK');
    assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');

    const markdownBytes = await readFile(join(jobRoot, report.formats.markdown.relativePath));
    const repeated = await generateImplementationReport(job, fixtureDeployment(), paths, 1);
    assert.deepEqual(repeated, report);
    assert.deepEqual(await readFile(join(jobRoot, report.formats.markdown.relativePath)), markdownBytes);

    const changedDeployment = { ...fixtureDeployment(), packageHash: 'different-package' };
    await assert.rejects(() => generateImplementationReport(job, changedDeployment, paths, 1), /immutable report already exists/i);

    const publicReport = publicImplementationReport(report);
    const serialized = JSON.stringify(publicReport);
    assert.doesNotMatch(serialized, /relativePath|sha256|contentBase64|source-secret|package-secret/);
  } finally {
    config.workspaceRoot = originalWorkspaceRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects unsupported formats, unknown versions, and cross-job artifact paths', async () => {
  const job = fixtureJob();
  await assert.rejects(() => readImplementationReportArtifact(job, 0, 'pdf'), /positive integer/i);
  await assert.rejects(() => readImplementationReportArtifact(job, 1, 'html'), /unsupported/i);
  await assert.rejects(() => readImplementationReportArtifact(job, 1, 'pdf'), /not found/i);
});
