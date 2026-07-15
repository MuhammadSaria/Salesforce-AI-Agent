import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { config } from '../config.js';
import { redactSecrets } from '../utils/sanitize.js';
import { isPathInside } from '../utils/paths.js';
import { auditSalesforceOperation } from './auditLog.js';

const COMMANDS = {
  writeMetadataFile: {
    run: writeMetadataFileCommand,
    validate: ({ path, content }) => {
      validateMetadataPath(path);
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('Metadata file content is required.');
      }
      if (content.length > 500000) {
        throw new Error('Metadata file content is too large.');
      }
    }
  },
  orgDisplay: {
    operation: 'read',
    args: ({ targetOrg }) => ['org', 'display', '--target-org', targetOrg, '--json']
  },
  dataQuery: {
    operation: 'read',
    args: ({ query, targetOrg }) => ['data', 'query', '--query', query, '--target-org', targetOrg, '--json'],
    validate: ({ query }) => {
      if (!/^\s*select\b/i.test(query || '')) {
        throw new Error('Only SELECT SOQL queries are allowed.');
      }
      if (/\b(insert|update|upsert|delete|undelete|merge)\b/i.test(query)) {
        throw new Error('Mutation keywords are not allowed in read-only SOQL.');
      }
    }
  },
  sobjectDescribe: {
    operation: 'read',
    args: ({ objectApiName, targetOrg }) => ['sobject', 'describe', '--sobject', objectApiName, '--target-org', targetOrg, '--json'],
    validate: ({ objectApiName }) => validateApiName(objectApiName, 'object')
  },
  dataCreate: {
    operation: 'data-create',
    requiresApproval: true,
    args: ({ objectApiName, fields, targetOrg }) => ['data', 'create', 'record', '--sobject', objectApiName, '--values', formatFieldValues(fields), '--target-org', targetOrg, '--json'],
    validate: ({ objectApiName, fields }) => { validateApiName(objectApiName, 'object'); validateDataFields(fields); }
  },
  dataUpdate: {
    operation: 'data-update',
    requiresApproval: true,
    args: ({ objectApiName, recordId, fields, targetOrg }) => ['data', 'update', 'record', '--sobject', objectApiName, '--record-id', recordId, '--values', formatFieldValues(fields), '--target-org', targetOrg, '--json'],
    validate: ({ objectApiName, recordId, fields }) => {
      validateApiName(objectApiName, 'object');
      if (!/^[A-Za-z0-9]{15,18}$/.test(String(recordId || ''))) throw new Error('A valid Salesforce record ID is required for update.');
      validateDataFields(fields);
    }
  },
  dataDelete: {
    operation: 'data-delete',
    requiresApproval: true,
    args: ({ objectApiName, recordId, targetOrg }) => ['data', 'delete', 'record', '--sobject', objectApiName, '--record-id', recordId, '--target-org', targetOrg, '--json'],
    validate: ({ objectApiName, recordId }) => {
      validateApiName(objectApiName, 'object');
      if (!/^[A-Za-z0-9]{15,18}$/.test(String(recordId || ''))) throw new Error('A valid Salesforce record ID is required for delete.');
    }
  },
  retrieveManifest: {
    operation: 'retrieve',
    args: ({ manifest, targetOrg, outputDir }) => [
      'project',
      'retrieve',
      'start',
      '--manifest',
      manifest,
      '--target-org',
      targetOrg,
      '--output-dir',
      outputDir,
      '--json'
    ],
    validate: ({ manifest, outputDir }) => { validateManifestPath(manifest); validateJobOutputPath(outputDir); }
  },
  runApexTests: {
    operation: 'validate',
    args: ({ tests, targetOrg }) => {
      const args = ['apex', 'run', 'test', '--target-org', targetOrg, '--result-format', 'human', '--wait', '30', '--json'];
      if (tests) {
        args.push('--tests', tests);
      }
      return args;
    }
  },
  deployPreview: {
    operation: 'validate',
    args: ({ manifest, targetOrg }) => ['project', 'deploy', 'preview', '--manifest', manifest, '--target-org', targetOrg, '--json'],
    validate: ({ manifest }) => validateManifestPath(manifest)
  },
  deployDryRun: {
    operation: 'validate',
    args: ({ manifest, targetOrg, tests }) => {
      const args = ['project', 'deploy', 'start', '--dry-run', '--manifest', manifest, '--target-org', targetOrg, '--test-level', tests ? 'RunSpecifiedTests' : 'RunLocalTests', '--json'];
      if (tests) args.push('--tests', tests);
      return args;
    },
    validate: ({ manifest }) => validateManifestPath(manifest)
  },
  deployManifest: {
    operation: 'deploy',
    requiresApproval: true,
    args: ({ manifest, targetOrg, tests }) => {
      const args = ['project', 'deploy', 'start', '--manifest', manifest, '--target-org', targetOrg, '--test-level', tests ? 'RunSpecifiedTests' : 'RunLocalTests', '--json'];
      if (tests) args.push('--tests', tests);
      return args;
    },
    validate: ({ manifest }) => validateManifestPath(manifest)
  }
};

async function writeMetadataFileCommand({ path, content }) {
  const filePath = resolveMetadataPath(path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');

  return {
    command: `writeMetadataFile ${relative(config.projectRoot, filePath)}`,
    exitCode: 0,
    stdout: JSON.stringify({ status: 0, result: { path: relative(config.projectRoot, filePath) } }, null, 2),
    stderr: ''
  };
}

export async function runSfCommand(command, params = {}, options = {}) {
  const definition = COMMANDS[command];
  if (!definition) {
    throw new Error(`Blocked sf command: ${command}`);
  }

  const orgContext = options.orgContext;
  if (!orgContext?.salesforceAlias || !orgContext?.expectedOrgId) {
    throw new Error('A verified Salesforce org context is required before running Salesforce commands.');
  }

  if (definition.requiresApproval && !options.approved) {
    const error = new Error(`Command ${command} requires explicit approval.`);
    error.code = 'NEEDS_APPROVAL';
    throw error;
  }

  if (definition.operation && !orgContext.allowedOperations?.includes(definition.operation)) {
    throw new Error(`Operation ${definition.operation} is not allowed for the selected Salesforce org.`);
  }

  if (params.targetOrg && params.targetOrg !== orgContext.salesforceAlias) {
    throw new Error('Command target org does not match the selected Salesforce org.');
  }

  const verifiedOrg = await verifySelectedOrg(orgContext, {
    jobId: options.jobId,
    actor: options.actor,
    jiraIssueKey: options.jiraIssueKey,
    metadataScope: options.metadataScope
  });
  const paths = options.jobPaths || {};
  const targetOrg = orgContext.salesforceAlias;
  const resolvedParams = {
    ...params,
    targetOrg,
    path: normalizeMetadataWritePath(params.path, options.jobId, options.localProjectRoot),
    outputDir: params.outputDir || paths.retrievedMetadata || join(config.workspaceRoot, 'jobs', options.jobId || 'unknown', 'retrieved-metadata')
  };
  definition.validate?.(resolvedParams);

  const started = new Date().toISOString();
  let result;
  if (definition.run) {
    result = await definition.run(resolvedParams, options);
  } else {
    const args = definition.args(resolvedParams);
    if (!args.includes('--target-org') || !args.includes(targetOrg)) {
      throw new Error('Blocked Salesforce CLI command without explicit target org.');
    }
    result = await executeSf(args, options.timeoutMs || config.sfCommandTimeoutMs, options.cwd || config.projectRoot);
  }

  await auditSalesforceOperation({
    jobId: options.jobId,
    jiraIssueKey: options.jiraIssueKey,
    orgRegistryId: orgContext.orgRegistryId,
    salesforceOrgId: verifiedOrg.organizationId,
    salesforceAlias: orgContext.salesforceAlias,
    environment: orgContext.environment,
    commandCategory: command,
    metadataScope: options.metadataScope,
    startTimestamp: started,
    endTimestamp: new Date().toISOString(),
    result: result.exitCode === 0 ? 'success' : `failed:${result.exitCode}`,
    actor: options.actor || 'system'
  });

  return result;
}

function validateManifestPath(manifest) {
  const fullPath = resolve(String(manifest || ''));
  const jobsRoot = resolve(config.workspaceRoot, 'jobs');
  if (!fullPath.endsWith('.xml') || !isPathInside(jobsRoot, fullPath)) {
    throw new Error('Manifest must be an XML file inside the isolated jobs workspace.');
  }
}

function validateJobOutputPath(path) {
  const fullPath = resolve(String(path || ''));
  const jobsRoot = resolve(config.workspaceRoot, 'jobs');
  if (!isPathInside(jobsRoot, fullPath)) throw new Error('Output path must stay inside the isolated jobs workspace.');
}

function validateApiName(value, label) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(value || ''))) throw new Error(`Invalid Salesforce ${label} API name.`);
}

function validateDataFields(fields) {
  if (!fields || Array.isArray(fields) || typeof fields !== 'object' || !Object.keys(fields).length) throw new Error('Explicit Salesforce field values are required.');
  for (const [field, value] of Object.entries(fields)) {
    validateApiName(field, 'field');
    if (/password|token|secret|session/i.test(field)) throw new Error(`Blocked sensitive Salesforce field: ${field}.`);
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`Invalid value for Salesforce field ${field}.`);
  }
}

function formatFieldValues(fields) {
  validateDataFields(fields);
  return Object.entries(fields).map(([field, value]) => `${field}='${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(' ');
}

function normalizeMetadataWritePath(path, jobId, localProjectRoot) {
  const relativePath = String(path || '').replace(/\\/g, '/');
  if (!relativePath || !jobId || !relativePath.startsWith('force-app/')) {
    return path;
  }
  if (localProjectRoot) {
    const fullRoot = resolve(localProjectRoot);
    const jobsRoot = resolve(config.workspaceRoot, 'jobs');
    if (!isPathInside(jobsRoot, fullRoot)) throw new Error('Local implementation root must stay inside the jobs workspace.');
    return relative(config.projectRoot, resolve(fullRoot, relativePath)).replace(/\\/g, '/');
  }
  return `jobs/${jobId}/workspace/${relativePath}`;
}

function validateMetadataPath(path) {
  resolveMetadataPath(path);
}

function resolveMetadataPath(path) {
  const relativePath = String(path || '').replace(/\\/g, '/');
  if (!relativePath || relativePath.includes('\0') || relativePath.startsWith('/') || relativePath.includes('..')) {
    throw new Error('Metadata path must be a relative path under force-app/main/default.');
  }

  const baseRoot = resolve(config.workspaceRoot, 'jobs');
  const basePath = resolve(config.projectRoot, 'force-app', 'main', 'default');
  const fullPath = resolve(config.projectRoot, relativePath);
  const relativeToBase = relative(basePath, fullPath);

  const relativeToJobs = relative(baseRoot, fullPath);
  if ((relativeToBase.startsWith('..') || resolve(basePath, relativeToBase) !== fullPath) && relativeToJobs.startsWith('..')) {
    throw new Error('Metadata path must stay under force-app/main/default.');
  }

  if (!/\.(xml|cls|js|html|css|svg|json|md|page|trigger|cmp|app|design|auradoc|tokens)$/i.test(fullPath)) {
    throw new Error('Metadata file extension is not allowed.');
  }

  return fullPath;
}

export async function verifySelectedOrg(orgContext, options = {}) {
  const started = new Date().toISOString();
  const result = await executeSf(['org', 'display', '--target-org', orgContext.salesforceAlias, '--json'], config.sfCommandTimeoutMs);
  const parsed = parseSfJson(result.stdout);
  const actualOrgId = parsed?.result?.id || parsed?.result?.orgId || parsed?.result?.organizationId || '';
  const actualAlias = parsed?.result?.alias || orgContext.salesforceAlias;
  const actualInstanceUrl = parsed?.result?.instanceUrl || '';
  const actualUsername = parsed?.result?.username || '';
  const actualIsSandbox = parsed?.result?.isSandbox;
  const connected = result.exitCode === 0 && actualOrgId;
  const expectsSandbox = ['sandbox', 'partial-copy', 'full-copy'].includes(orgContext.environment);
  const environmentMismatch =
    (typeof actualIsSandbox === 'boolean' && expectsSandbox !== actualIsSandbox && orgContext.environment !== 'scratch' && orgContext.environment !== 'developer') ||
    (orgContext.environment === 'scratch' && parsed?.result?.isScratchOrg === false);

  const mismatch =
    !connected ||
    normalizeOrgId(actualOrgId) !== normalizeOrgId(orgContext.expectedOrgId) ||
    (actualAlias && actualAlias !== orgContext.salesforceAlias) ||
    (orgContext.instanceUrl && actualInstanceUrl && normalizeUrl(actualInstanceUrl) !== normalizeUrl(orgContext.instanceUrl)) ||
    (orgContext.expectedUsername && actualUsername.toLowerCase() !== orgContext.expectedUsername.toLowerCase()) ||
    environmentMismatch;

  await auditSalesforceOperation({
    jobId: options.jobId,
    jiraIssueKey: options.jiraIssueKey,
    orgRegistryId: orgContext.orgRegistryId,
    salesforceOrgId: actualOrgId || orgContext.expectedOrgId,
    salesforceAlias: orgContext.salesforceAlias,
    environment: orgContext.environment,
    commandCategory: 'orgVerification',
    metadataScope: options.metadataScope,
    startTimestamp: started,
    endTimestamp: new Date().toISOString(),
    result: mismatch ? 'ORG_VERIFICATION_FAILED' : 'verified',
    actor: options.actor || 'system'
  });

  if (mismatch) {
    const error = new Error(
      `Salesforce org verification failed for registry org ${orgContext.orgRegistryId}. Expected ${orgContext.expectedOrgId}, got ${actualOrgId || 'unknown'}.`
    );
    error.code = 'ORG_VERIFICATION_FAILED';
    error.details = {
      expectedOrgId: orgContext.expectedOrgId,
      actualOrgId,
      expectedInstanceUrl: orgContext.instanceUrl,
      actualInstanceUrl,
      actualAlias
    };
    throw error;
  }

  return {
    organizationId: actualOrgId,
    alias: actualAlias,
    instanceUrl: actualInstanceUrl,
    username: actualUsername,
    connected: true,
    environment: orgContext.environment,
    verifiedAt: new Date().toISOString()
  };
}

function executeSf(args, timeoutMs, cwd = config.projectRoot) {
  return new Promise((resolve) => {
    const invocation = getSfInvocation(args);
    const child = spawn(invocation.executable, invocation.args, {
      shell: false,
      windowsHide: true,
      cwd,
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    let killTimer;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      stderr += `\nCommand timed out after ${timeoutMs}ms.`;
      // Escalate to SIGKILL if the process ignores SIGTERM, so the job cannot hang forever.
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        command: invocation.display,
        exitCode: 1,
        stdout: '',
        stderr: redactSecrets(error.message)
      });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        command: invocation.display,
        exitCode,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr)
      });
    });
  });
}

function parseSfJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function normalizeOrgId(value) {
  return String(value || '').trim().slice(0, 15).toUpperCase();
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/$/, '').toLowerCase();
}

function getSfInvocation(args) {
  if (process.platform === 'win32' && config.sfCliNode && config.sfCliRun) {
    return {
      executable: config.sfCliNode,
      args: ['--no-deprecation', config.sfCliRun, ...args],
      display: `sf ${args.join(' ')}`
    };
  }

  return {
    executable: 'sf',
    args,
    display: `sf ${args.join(' ')}`
  };
}
