import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import { canonicalMetadataPath } from '../domain/metadataPath.js';
import { stableHash } from '../utils/hash.js';
import { isPathInside } from '../utils/paths.js';
import { runGit } from './gitExecutor.js';
import { sameSalesforceId } from '../utils/salesforceId.js';

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
    jira: join(jobRoot, 'jira'),
    orgBaseline: resolve(config.workspaceRoot, 'workspaces', orgRegistryId, 'baseline'),
    orgProject: resolve(config.workspaceRoot, 'workspaces', orgRegistryId, 'project')
  };
}

export async function ensureJobWorkspace(jobId, orgRegistryId) {
  const paths = getJobPaths(jobId, orgRegistryId);
  await Promise.all(
    [paths.workspace, paths.manifest, paths.retrievedMetadata, paths.analysis, paths.plan, paths.implementation, paths.validation, paths.diff, paths.logs, paths.approvals, paths.deployment, paths.jira].map((path) =>
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

export async function captureMetadataBaseline({ projectRoot, operations, trustedSourceOrgId, retrieve, runGitCommand = runGit, assertAuthority = () => {} } = {}) {
  const root = resolve(String(projectRoot || ''));
  const approved = normalizeBaselineOperations(operations);
  const approvedPaths = new Set(approved.map((item) => item.path));

  for (const item of approved) {
    const target = resolve(root, item.path);
    if (!isPathInside(root, target)) throw baselineError('BASELINE_PATH_INVALID', 'Baseline path is outside the isolated worktree.');
    await rm(target, { force: true });
  }

  const components = approved.map(({ metadataType: type, apiName }) => ({ type, apiName }));
  const retrieval = await retrieve(components);
  const requestedKeys = components.map(({ type, apiName }) => `${type}:${apiName}`).sort();
  if (retrieval?.exitCode !== 0
    || !successfulSalesforceResult(retrieval.stdout)
    || !sameSalesforceId(retrieval.sourceOrgId, trustedSourceOrgId)
    || stableHash([...(retrieval.componentKeys || [])].sort()) !== stableHash(requestedKeys)) {
    throw baselineError('BASELINE_RETRIEVAL_FAILED', 'Exact metadata baseline retrieval failed.');
  }
  await assertAuthority();

  const files = [];
  for (const item of approved) {
    const target = resolve(root, item.path);
    const present = await fileExists(target);
    if (present && item.operation === 'create') {
      throw baselineError('BASELINE_COMPONENT_ALREADY_EXISTS', 'An approved CREATE component already exists in the trusted source org.');
    }
    if (!present && item.operation !== 'create') {
      throw baselineError('BASELINE_COMPONENT_MISSING', 'An approved existing component was not returned by exact baseline retrieval.');
    }
    files.push(present
      ? { path: item.path, state: 'PRESENT', hash: stableHash(await readFile(target, 'utf8')) }
      : { path: item.path, state: 'ABSENT' });
  }

  const before = await runGitCommand('status', { cwd: root });
  if (before.exitCode !== 0) throw baselineError('BASELINE_GIT_FAILED', 'Unable to inspect the isolated baseline worktree.');
  const changedPaths = porcelainPaths(before.stdout);
  if (changedPaths.some((path) => !approvedPaths.has(path))) {
    throw baselineError('BASELINE_WORKTREE_CONTAMINATED', 'The isolated baseline worktree contains unexpected changes.');
  }
  await assertAuthority();
  if (changedPaths.length) {
    const add = await runGitCommand('add', { paths: changedPaths, cwd: root });
    if (add.exitCode !== 0) throw baselineError('BASELINE_GIT_FAILED', 'Unable to stage the exact metadata baseline.');
  }
  const commit = await runGitCommand('commit', { message: 'Providus Nexus immutable metadata baseline', allowEmpty: true, cwd: root });
  if (commit.exitCode !== 0) throw baselineError('BASELINE_GIT_FAILED', 'Unable to commit the immutable metadata baseline.');
  const after = await runGitCommand('status', { cwd: root });
  if (after.exitCode !== 0 || after.stdout.trim()) throw baselineError('BASELINE_WORKTREE_NOT_CLEAN', 'The baseline worktree is not clean after commit.');
  const head = await runGitCommand('rev-parse', { ref: 'HEAD', cwd: root });
  const baselineCommit = String(head.stdout || '').trim();
  if (head.exitCode !== 0 || !/^[a-f0-9]{7,64}$/i.test(baselineCommit)) throw baselineError('BASELINE_GIT_FAILED', 'Unable to identify the immutable metadata baseline commit.');
  return { baselineCommit, files };
}

function normalizeBaselineOperations(operations) {
  if (!Array.isArray(operations) || !operations.length) throw baselineError('BASELINE_OPERATIONS_INVALID', 'Approved metadata operations are required.');
  const seen = new Set();
  return operations.map((operation) => {
    const path = canonicalMetadataPath(operation.metadataType, operation.apiName);
    if (operation.path !== path || !['create', 'modify', 'delete'].includes(operation.operation) || seen.has(path)) {
      throw baselineError('BASELINE_OPERATIONS_INVALID', 'Approved metadata operations are invalid.');
    }
    seen.add(path);
    return { operation: operation.operation, metadataType: operation.metadataType, apiName: operation.apiName, path };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function porcelainPaths(stdout) {
  if (!String(stdout || '').trim()) return [];
  return String(stdout).trimEnd().split(/\r?\n/).map((line) => {
    if (line.length < 4 || line.includes(' -> ') || line[2] !== ' ') throw baselineError('BASELINE_WORKTREE_CONTAMINATED', 'The isolated baseline worktree contains an unsupported change.');
    return line.slice(3).replace(/^"|"$/g, '');
  });
}

function successfulSalesforceResult(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || ''));
    return parsed?.status === 0 && !parsed?.warnings?.length;
  } catch { return false; }
}

async function fileExists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function baselineError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
