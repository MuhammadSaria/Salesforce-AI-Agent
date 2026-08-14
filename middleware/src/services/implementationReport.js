import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';

export async function writeImplementationReport({ job, deployment, paths } = {}) {
  if (!job?.implementationBaseline?.baselineCommit || deployment?.status !== 'SUCCEEDED' || deployment?.activated !== false) {
    throw Object.assign(new Error('Complete inactive deployment evidence is required before reporting.'), { code: 'REPORT_EVIDENCE_REQUIRED', statusCode: 409 });
  }
  const reportId = nanoid();
  const report = {
    reportId,
    jobId: job.jobId,
    summary: 'The approved recurring-donation metadata was validated and deployed inactive.',
    components: (job.plan?.components || []).map(({ metadataType, apiName }) => ({ metadataType, apiName })),
    baselineCommit: job.implementationBaseline.baselineCommit,
    validationId: deployment.validationId,
    deploymentId: deployment.deploymentId,
    sourceHash: deployment.sourceHash,
    packageHash: deployment.packageHash,
    commitHash: deployment.commitHash,
    flowStatus: 'Draft',
    generatedAt: new Date().toISOString()
  };
  await writeFile(join(paths.deployment, `${reportId}.json`), JSON.stringify(report, null, 2), 'utf8');
  return report;
}
