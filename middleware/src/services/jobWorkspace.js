import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config.js';

export function getJobPaths(jobId, orgRegistryId) {
  const jobRoot = resolve(config.workspaceRoot, 'jobs', jobId);
  return {
    jobRoot,
    orgContext: join(jobRoot, 'org-context.json'),
    workspace: join(jobRoot, 'workspace'),
    manifest: join(jobRoot, 'manifest'),
    retrievedMetadata: join(jobRoot, 'retrieved-metadata'),
    analysis: join(jobRoot, 'analysis'),
    plan: join(jobRoot, 'plan'),
    implementation: join(jobRoot, 'implementation'),
    implementationProject: join(jobRoot, 'implementation', 'project'),
    validation: join(jobRoot, 'validation'),
    diff: join(jobRoot, 'diff'),
    logs: join(jobRoot, 'logs'),
    approvals: join(jobRoot, 'approvals'),
    deployment: join(jobRoot, 'deployment'),
    implementationReports: join(jobRoot, 'deployment', 'reports'),
    jira: join(jobRoot, 'jira'),
    orgBaseline: resolve(config.workspaceRoot, 'workspaces', orgRegistryId, 'baseline'),
    orgProject: resolve(config.workspaceRoot, 'workspaces', orgRegistryId, 'project')
  };
}

export async function ensureJobWorkspace(jobId, orgRegistryId) {
  const paths = getJobPaths(jobId, orgRegistryId);
  await Promise.all(
    [paths.workspace, paths.manifest, paths.retrievedMetadata, paths.analysis, paths.plan, paths.implementation, paths.validation, paths.diff, paths.logs, paths.approvals, paths.deployment, paths.implementationReports, paths.jira].map((path) =>
      mkdir(path, { recursive: true })
    )
  );
  return paths;
}

export async function writeOrgContext(jobId, orgContext) {
  const paths = await ensureJobWorkspace(jobId, orgContext.orgRegistryId);
  await writeFile(paths.orgContext, JSON.stringify(orgContext, null, 2), 'utf8');
  return paths;
}
