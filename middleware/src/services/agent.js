import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { JOB_STATES } from '../domain/jobState.js';
import { config } from '../config.js';
import { stableHash } from '../utils/hash.js';
import { appendCommand, appendLog, getJobRecord, transitionJob, updateJob } from './jobStore.js';
import { auditEvent } from './auditLog.js';
import { buildOrgContext, selectOrgForJob } from './orgRegistry.js';
import { ensureJobWorkspace, writeOrgContext } from './jobWorkspace.js';
import { addJiraComment, getJiraIssue } from './jira.js';
import { analyzeDependencies, buildMetadataScope, buildPlan, expandScopeForFileOperations, extractRequirement, writeManifest } from './planning.js';
import { runSfCommand, verifySelectedOrg } from './sfExecutor.js';
import { runGit } from './gitExecutor.js';
import { enrichPlanWithCodex } from './codexExecutor.js';

export async function processAgentJob(message) {
  const job = await requiredJob(message.jobId);
  const actor = message.actor || 'system';
  if (message.action === 'analyze') return analyze(job, actor);
  if (message.action === 'implement') return implement(job, actor);
  if (message.action === 'validate') return validate(job, actor);
  if (message.action === 'deploy') return deploy(job, actor);
  throw new Error(`Unsupported worker action: ${message.action}`);
}

async function analyze(job, actor) {
  // Webhook issue payloads can omit fields, so Jira remains the authoritative source.
  const jira = job.jiraIssueKey ? await getJiraIssue(job.jiraIssueKey) : job.jira;
  const routingContext = jira ? {
    ...job.context,
    jiraProjectKey: jira.projectKey,
    jiraComponents: jira.components,
    jiraCustomFields: jira.customFields
  } : job.context;
  if (jira) await updateJob(job.jobId, { jira, context: routingContext });
  job = { ...job, jira, context: routingContext };

  const selection = await selectOrgForJob(job);
  if (selection.status !== 'selected') {
    await transitionJob(job.jobId, JOB_STATES.AWAITING_ORG_SELECTION, { actor, reason: selection.status === 'ambiguous' ? 'Multiple trusted org mappings matched.' : 'No trusted org mapping matched.' });
    await updateJob(job.jobId, { orgCandidates: selection.candidates, orgRoutingEvidence: selection.evidence });
    return;
  }

  await transitionJob(job.jobId, JOB_STATES.VERIFYING_ORG, { actor, reason: `Selected by ${selection.source}.` });
  const orgContext = buildOrgContext(selection, job);
  const paths = await writeOrgContext(job.jobId, orgContext);
  await updateJob(job.jobId, { orgContext, orgCandidates: [], orgRoutingEvidence: selection.evidence });
  try {
    const verified = await verifySelectedOrg(orgContext, auditOptions(job, actor));
    await updateJob(job.jobId, { orgContext: { ...orgContext, verified } });
  } catch (error) {
    await transitionJob(job.jobId, JOB_STATES.ORG_VERIFICATION_FAILED, { actor, reason: 'Expected and connected org identity did not match.', error: error.message });
    return;
  }

  await transitionJob(job.jobId, JOB_STATES.ANALYZING_JIRA, { actor, reason: 'Org verified.' });
  const requirement = extractRequirement(jira, job.prompt, job.instructions);
  await writeFile(join(paths.analysis, 'requirement.json'), JSON.stringify(requirement, null, 2), 'utf8');
  await updateJob(job.jobId, { jira, requirement });

  await transitionJob(job.jobId, JOB_STATES.DISCOVERING_METADATA, { actor, reason: 'Requirement extracted.' });
  const scope = buildMetadataScope(requirement, orgContext);
  const manifest = await writeManifest(paths, scope);
  await updateJob(job.jobId, { metadataScope: scope, manifest });

  await transitionJob(job.jobId, JOB_STATES.RETRIEVING_RELEVANT_METADATA, { actor, reason: `${scope.primaryMetadata.length} task-relevant components scoped.` });
  if (scope.primaryMetadata.length) {
    const result = await runSfCommand('retrieveManifest', { manifest }, sfOptions(job, orgContext, paths, actor, scope));
    await appendCommand(job.jobId, result);
    if (result.exitCode !== 0) throw new Error(`Selective metadata retrieval failed: ${result.stderr}`);
  }

  await transitionJob(job.jobId, JOB_STATES.ANALYZING_DEPENDENCIES, { actor, reason: 'Selective retrieval completed.' });
  const dependencies = await analyzeDependencies(paths, scope);
  const current = await requiredJob(job.jobId);
  const basePlan = buildPlan({ ...current, orgContext }, requirement, scope, dependencies);
  let plan = await enrichPlanWithCodex(basePlan, requirement, { ...scope, dependencies }, orgContext);
  const finalScope = expandScopeForFileOperations({ ...scope, dependencies }, plan.fileOperations, orgContext);
  await writeManifest(paths, finalScope);
  const planWithoutHash = { ...plan, metadataScopeHash: finalScope.hash };
  delete planWithoutHash.planHash;
  plan = { ...planWithoutHash, planHash: stableHash(planWithoutHash) };
  await writeFile(join(paths.plan, `plan-v${plan.planVersion}.json`), JSON.stringify(plan, null, 2), 'utf8');
  await updateJob(job.jobId, { plan, metadataScope: finalScope });
  await transitionJob(job.jobId, JOB_STATES.AWAITING_PLAN_APPROVAL, { actor, reason: 'Versioned implementation plan generated.' });
  await auditEvent({ ...auditOptions(job, actor), orgRegistryId: orgContext.orgRegistryId, salesforceOrgId: orgContext.expectedOrgId, environment: orgContext.environment, action: 'PLAN_GENERATED', result: 'success', safeMetadata: { planVersion: plan.planVersion, planHash: plan.planHash, metadataScopeHash: scope.hash } });
  if (job.jiraIssueKey) {
    try {
      await addJiraComment(job.jiraIssueKey, planReviewComment(job, plan, orgContext));
    } catch (error) {
      await appendLog(job.jobId, 'warn', `Plan generated, but the Jira review comment could not be added: ${error.message}`);
    }
  }
}

async function implement(job, actor) {
  assertState(job, JOB_STATES.IMPLEMENTING, JOB_STATES.VALIDATION_FAILED);
  const approval = validApproval(job, 'IMPLEMENTATION');
  if (job.status === JOB_STATES.VALIDATION_FAILED) {
    if (job.implementation) return validate(job, actor);
    await transitionJob(job.jobId, JOB_STATES.IMPLEMENTING, { actor, reason: 'Retrying missing local implementation before validation.' });
    job = await requiredJob(job.jobId);
  }
  await verifySelectedOrg(job.orgContext, auditOptions(job, actor));
  const paths = await ensureJobWorkspace(job.jobId, job.orgContext.orgRegistryId);
  const branch = `ai-agent/${(job.jiraIssueKey || 'MANUAL-0').toUpperCase()}-${job.jobId}`.replace(/[^A-Za-z0-9_\/-]/g, '-');
  const branchResult = await runGit('worktree-add', { branch, path: paths.implementationProject });
  if (branchResult.exitCode !== 0) throw new Error(`Cannot create the required Git branch. ${branchResult.stderr}`);
  const baselineResult = await runGit('rev-parse', { ref: 'HEAD', cwd: paths.implementationProject });

  const changedFiles = [];
  for (const operation of job.plan.fileOperations || []) {
    if (!['create', 'modify'].includes(operation.operation)) throw new Error('Destructive file operations require a separately approved plan and are blocked by default.');
    const result = await runSfCommand('writeMetadataFile', { path: operation.path, content: operation.content }, { ...sfOptions(job, job.orgContext, paths, actor, job.metadataScope, true), localProjectRoot: paths.implementationProject, cwd: paths.implementationProject });
    await appendCommand(job.jobId, result);
    changedFiles.push(operation.path);
  }
  const sourceHash = stableHash({ planHash: job.plan.planHash, files: job.plan.fileOperations || [], dataOperations: job.plan.dataOperations || [] });
  let diffResult = { stdout: '', exitCode: 0 };
  let commitHash = baselineResult.stdout.trim();
  if (changedFiles.length) {
    const addResult = await runGit('add', { paths: changedFiles, cwd: paths.implementationProject });
    if (addResult.exitCode !== 0) throw new Error(`Cannot stage approved files. ${addResult.stderr}`);
    diffResult = await runGit('diff', { paths: changedFiles, cached: true, cwd: paths.implementationProject });
    const commitResult = await runGit('commit', { message: `${job.jiraIssueKey || 'Manual'}: approved AI agent implementation`, cwd: paths.implementationProject });
    if (commitResult.exitCode !== 0) throw new Error(`Cannot commit approved files. ${commitResult.stderr}`);
    commitHash = (await runGit('rev-parse', { ref: 'HEAD', cwd: paths.implementationProject })).stdout.trim();
  }
  await writeFile(join(paths.diff, 'implementation.diff'), diffResult.stdout, 'utf8');
  await updateJob(job.jobId, { implementation: { approvalId: approval.approvalId, branch, baselineCommit: baselineResult.stdout.trim(), commitHash, changedFiles, sourceHash, implementedAt: new Date().toISOString() }, diff: diffResult.stdout });
  await appendLog(job.jobId, 'info', changedFiles.length ? `Implemented ${changedFiles.length} approved file operations locally. No deployment or data mutation was performed.` : `Prepared ${(job.plan.dataOperations || []).length} approved data operations. No data mutation was performed.`);
  return validate(await requiredJob(job.jobId), actor);
}

async function validate(job, actor) {
  assertState(job, JOB_STATES.IMPLEMENTING, JOB_STATES.VALIDATION_FAILED);
  validApproval(job, 'IMPLEMENTATION');
  await transitionJob(job.jobId, JOB_STATES.VALIDATING, { actor, reason: 'Validation requested.' });
  try {
    const current = await requiredJob(job.jobId);
    const paths = await ensureJobWorkspace(current.jobId, current.orgContext.orgRegistryId);
    await verifySelectedOrg(current.orgContext, auditOptions(current, actor));
    await assertCleanImplementation(paths, current.implementation);
    const dataOperations = current.plan.dataOperations || [];
    const hasSourceChanges = Boolean((current.plan.fileOperations || []).length || (current.implementation?.changedFiles || []).length);
    if (hasSourceChanges && dataOperations.length) throw new Error('Metadata and record mutations must be split into separate jobs to prevent partial execution.');
    const dataValidationCommands = await validatePlannedDataOperations(current, paths, actor);
    if (!hasSourceChanges && !dataOperations.length) {
      const now = new Date();
      const validation = { validationId: nanoid(), targetOrgId: current.orgContext.expectedOrgId, status: 'PASSED', outcome: 'NO_CHANGES', sourceHash: current.implementation?.sourceHash || stableHash([]), commitHash: current.implementation?.commitHash || '', planHash: current.plan.planHash, metadataScopeHash: current.metadataScope.hash, packageHash: stableHash([]), commands: [], result: 'No source changes were proposed, so Salesforce deployment validation was not required.', warnings: ['No Salesforce source changes to validate or deploy.'], timestamp: now.toISOString(), expiryTimestamp: new Date(now.getTime() + config.validationExpiryMinutes * 60000).toISOString() };
      await writeFile(join(paths.validation, `${validation.validationId}.json`), JSON.stringify(validation, null, 2), 'utf8');
      await updateJob(current.jobId, { validation, deployment: { notRequired: true, reason: 'No source changes were proposed.' } });
      if (current.jiraIssueKey) await addJiraComment(current.jiraIssueKey, noChangeCompletionComment(current, validation));
      await transitionJob(current.jobId, JOB_STATES.COMPLETED, { actor, reason: 'Validation completed with no source changes; deployment was not required.' });
      return;
    }
    if (dataOperations.length) {
      const now = new Date();
      const validation = { validationId: nanoid(), targetOrgId: current.orgContext.expectedOrgId, status: 'PASSED', outcome: 'DATA_OPERATIONS_VALIDATED', sourceHash: current.implementation.sourceHash, commitHash: current.implementation.commitHash || '', planHash: current.plan.planHash, metadataScopeHash: current.metadataScope.hash, packageHash: stableHash(dataOperations), commands: dataValidationCommands, result: `${dataOperations.length} structured record operations passed object, field, permission, and target-org validation. No records were changed.`, timestamp: now.toISOString(), expiryTimestamp: new Date(now.getTime() + config.validationExpiryMinutes * 60000).toISOString() };
      await writeFile(join(paths.validation, `${validation.validationId}.json`), JSON.stringify(validation, null, 2), 'utf8');
      await updateJob(current.jobId, { validation });
      await transitionJob(current.jobId, JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL, { actor, reason: 'Data operations validated; separate execution approval required.' });
      return;
    }
    const result = await runSfCommand('deployDryRun', { manifest: current.manifest }, { ...sfOptions(current, current.orgContext, paths, actor, current.metadataScope), cwd: paths.implementationProject });
    await appendCommand(current.jobId, result);
    const now = new Date();
    if (result.exitCode !== 0) throw new Error(sfFailureMessage(result));
    const validation = { validationId: nanoid(), targetOrgId: current.orgContext.expectedOrgId, status: 'PASSED', sourceHash: current.implementation?.sourceHash || stableHash([]), commitHash: current.implementation?.commitHash || '', planHash: current.plan.planHash, metadataScopeHash: current.metadataScope.hash, packageHash: await fileHash(current.manifest), commands: [result.command], result: result.stdout, timestamp: now.toISOString(), expiryTimestamp: new Date(now.getTime() + config.validationExpiryMinutes * 60000).toISOString() };
    await writeFile(join(paths.validation, `${validation.validationId}.json`), JSON.stringify(validation, null, 2), 'utf8');
    await updateJob(current.jobId, { validation });
    await transitionJob(current.jobId, JOB_STATES.AWAITING_DEPLOYMENT_APPROVAL, { actor, reason: 'Validation passed.' });
  } catch (error) {
    await updateJob(job.jobId, { validation: { status: 'FAILED', error: error.message, timestamp: new Date().toISOString() } });
    await transitionJob(job.jobId, JOB_STATES.VALIDATION_FAILED, { actor, reason: 'Validation failed.', error: error.message });
  }
}

async function deploy(job, actor) {
  assertState(job, JOB_STATES.DEPLOYING);
  const approval = validApproval(job, 'DEPLOYMENT');
  assertDeploymentGuard(job, approval);
  const paths = await ensureJobWorkspace(job.jobId, job.orgContext.orgRegistryId);
  await verifySelectedOrg(job.orgContext, auditOptions(job, actor));
  await assertCleanImplementation(paths, job.implementation);
  const dataOperations = job.plan.dataOperations || [];
  let result;
  const recordResults = [];
  if (dataOperations.length) {
    for (const operation of dataOperations) {
      const command = operation.operation === 'create' ? 'dataCreate' : 'dataUpdate';
      result = await runSfCommand(command, operation, { ...sfOptions(job, job.orgContext, paths, actor, job.metadataScope, true), cwd: paths.implementationProject });
      await appendCommand(job.jobId, result);
      if (result.exitCode !== 0) {
        await updateJob(job.jobId, { deployment: { status: recordResults.length ? 'PARTIAL_FAILURE' : 'FAILED', targetOrgId: job.orgContext.expectedOrgId, recordResults, error: sfFailureMessage(result), failedAt: new Date().toISOString() } });
        await transitionJob(job.jobId, JOB_STATES.FAILED, { actor, reason: 'Approved data execution failed.', error: sfFailureMessage(result) });
        return;
      }
      recordResults.push({ operation: operation.operation, objectApiName: operation.objectApiName, recordId: extractRecordId(result.stdout) || operation.recordId });
    }
  } else {
    result = await runSfCommand('deployManifest', { manifest: job.manifest }, { ...sfOptions(job, job.orgContext, paths, actor, job.metadataScope, true), cwd: paths.implementationProject });
    await appendCommand(job.jobId, result);
    if (result.exitCode !== 0) {
      await transitionJob(job.jobId, JOB_STATES.FAILED, { actor, reason: 'Deployment failed.', error: sfFailureMessage(result) });
      return;
    }
  }
  const deployment = { deploymentId: dataOperations.length ? '' : extractDeployId(result.stdout), targetOrgId: job.orgContext.expectedOrgId, sourceHash: job.validation.sourceHash, packageHash: job.validation.packageHash, commitHash: job.validation.commitHash || '', result: dataOperations.length ? JSON.stringify(recordResults) : result.stdout, recordResults, deployedAt: new Date().toISOString() };
  await updateJob(job.jobId, { deployment });
  if (job.jiraIssueKey) await addJiraComment(job.jiraIssueKey, completionComment(job, deployment));
  await transitionJob(job.jobId, JOB_STATES.COMPLETED, { actor, reason: dataOperations.length ? 'Approved record operations executed and Jira updated.' : 'Approved package deployed and Jira updated.', approvalId: approval.approvalId });
}

function validApproval(job, type) {
  const approval = [...job.approvals].reverse().find((item) => item.approvalType === type && item.decision === 'APPROVED');
  if (!approval || approval.planHash !== job.plan?.planHash || approval.metadataScopeHash !== job.metadataScope?.hash || approval.salesforceOrganizationId !== job.orgContext?.expectedOrgId) throw Object.assign(new Error(`A current ${type.toLowerCase()} approval for this exact plan, scope, and org is required.`), { statusCode: 409 });
  return approval;
}

function assertDeploymentGuard(job, approval) {
  const validation = job.validation;
  if (!validation || validation.status !== 'PASSED' || new Date(validation.expiryTimestamp) <= new Date()) throw new Error('A current successful validation is required.');
  if (approval.validationId !== validation.validationId || approval.validatedSourceHash !== validation.sourceHash || approval.deploymentPackageHash !== validation.packageHash) throw new Error('Deployment approval does not match the validated artifacts.');
  if (job.orgContext.environment === 'production' && (!config.allowProductionDeployment || approval.productionSpecificApproval !== true)) throw new Error('Production execution is disabled or lacks production-specific approval.');
  const hasDataOperations = Boolean(job.plan.dataOperations?.length);
  if (hasDataOperations && job.orgContext.dataMutationPermission !== 'allowed') throw new Error('Data mutation is not enabled for the selected org registry entry.');
  if (!hasDataOperations && (job.orgContext.deploymentPermission !== 'allowed' || !job.orgContext.allowedOperations.includes('deploy'))) throw new Error('Deployment is not enabled for the selected org registry entry.');
  if (job.plan.destructiveChanges?.length) throw new Error('Destructive changes are blocked by default.');
}

function assertState(job, ...states) { if (!states.includes(job.status)) throw Object.assign(new Error(`Job must be in ${states.join(' or ')}.`), { statusCode: 409 }); }
function auditOptions(job, actor) { return { jobId: job.jobId, jiraIssueKey: job.jiraIssueKey, actor }; }
function sfOptions(job, orgContext, paths, actor, scope, approved = false) { return { ...auditOptions(job, actor), orgContext, jobPaths: paths, metadataScope: scope, approved }; }
async function requiredJob(jobId) { const job = await getJobRecord(jobId); if (!job) throw Object.assign(new Error('Job not found.'), { statusCode: 404 }); return job; }
async function fileHash(path) { return stableHash(await readFile(path, 'utf8')); }
function extractDeployId(stdout) { try { const parsed = JSON.parse(stdout); return parsed.result?.id || parsed.result?.deployId || ''; } catch { return ''; } }
function extractRecordId(stdout) { try { const parsed = JSON.parse(stdout); return parsed.result?.id || parsed.result?.recordId || ''; } catch { return ''; } }
async function validatePlannedDataOperations(job, paths, actor) {
  const operations = job.plan.dataOperations || [];
  if (!operations.length) return [];
  if (job.orgContext.dataMutationPermission !== 'allowed') throw new Error('Data mutation is blocked for the selected org.');
  if (operations.length > job.orgContext.maximumDataOperations) throw new Error(`Data operation count exceeds the org limit of ${job.orgContext.maximumDataOperations}.`);
  const commands = [];
  for (const operation of operations) {
    if (!job.orgContext.allowedDataObjects.includes(operation.objectApiName)) throw new Error(`Data operations on ${operation.objectApiName} are not allowed for this org.`);
    const requiredPermission = operation.operation === 'create' ? 'data-create' : 'data-update';
    if (!job.orgContext.allowedOperations.includes(requiredPermission)) throw new Error(`${requiredPermission} is not allowed for this org.`);
    const describe = await runSfCommand('sobjectDescribe', { objectApiName: operation.objectApiName }, sfOptions(job, job.orgContext, paths, actor, job.metadataScope));
    await appendCommand(job.jobId, describe); commands.push(describe.command);
    if (describe.exitCode !== 0) throw new Error(sfFailureMessage(describe));
    const fields = JSON.parse(describe.stdout)?.result?.fields || [];
    for (const fieldName of Object.keys(operation.fields)) {
      const field = fields.find((item) => item.name === fieldName);
      if (!field || (operation.operation === 'create' ? field.createable === false : field.updateable === false)) throw new Error(`Field ${operation.objectApiName}.${fieldName} is not ${operation.operation}able.`);
      const value = operation.fields[fieldName];
      if (field.type === 'picklist' && !field.picklistValues?.some((item) => item.active && item.value === String(value))) throw new Error(`Value ${value} is not an active option for ${operation.objectApiName}.${fieldName}.`);
      if (field.type === 'reference' && value && !/^[A-Za-z0-9]{15,18}$/.test(String(value))) throw new Error(`Field ${operation.objectApiName}.${fieldName} requires a valid Salesforce record ID.`);
      if (fieldName === 'RecordTypeId' && value) {
        const recordTypeQuery = await runSfCommand('dataQuery', { query: `SELECT Id FROM RecordType WHERE Id = '${value}' AND SObjectType = '${operation.objectApiName}' AND IsActive = true LIMIT 1` }, sfOptions(job, job.orgContext, paths, actor, job.metadataScope));
        await appendCommand(job.jobId, recordTypeQuery); commands.push(recordTypeQuery.command);
        if (recordTypeQuery.exitCode !== 0 || Number(JSON.parse(recordTypeQuery.stdout)?.result?.totalSize || 0) !== 1) throw new Error(`Record type ${value} is not active for ${operation.objectApiName} in the verified target org.`);
      }
    }
    if (operation.operation === 'update') {
      const query = await runSfCommand('dataQuery', { query: `SELECT Id FROM ${operation.objectApiName} WHERE Id = '${operation.recordId}' LIMIT 1` }, sfOptions(job, job.orgContext, paths, actor, job.metadataScope));
      await appendCommand(job.jobId, query); commands.push(query.command);
      if (query.exitCode !== 0 || Number(JSON.parse(query.stdout)?.result?.totalSize || 0) !== 1) throw new Error('The approved update record does not exist in the verified target org.');
    }
  }
  return commands;
}
async function assertCleanImplementation(paths, implementation) {
  if (!implementation) throw new Error('A completed local implementation record is required.');
  const status = await runGit('status', { cwd: paths.implementationProject });
  const head = await runGit('rev-parse', { ref: 'HEAD', cwd: paths.implementationProject });
  if (status.exitCode !== 0 || status.stdout.trim()) throw new Error('Implementation worktree contains unapproved or uncommitted changes.');
  if (head.stdout.trim() !== implementation.commitHash) throw new Error('Implementation Git commit no longer matches the approved source.');
}
function completionComment(job, deployment) {
  const recordResults = deployment.recordResults || [];
  const executionResult = recordResults.length
    ? `Record execution: ${recordResults.map((item) => `${item.operation} ${item.objectApiName} ${item.recordId}`).join(', ')}`
    : `Deployment ID: ${deployment.deploymentId || 'not returned'}`;
  return [`AI agent job ${job.jobId} completed.`, `Salesforce org: ${job.orgContext.displayName} (${job.orgContext.expectedOrgId})`, `Environment: ${job.orgContext.environment}`, `Validation: ${job.validation.status} (${job.validation.validationId})`, executionResult, `Rollback: ${job.plan.rollbackPlan}`].join('\n');
}
function planReviewComment(job, plan, orgContext) {
  const steps = (plan.implementationSteps || []).map((step, index) => `${index + 1}. ${step}`);
  return [
    'AI agent plan ready for review.',
    `Job: ${job.jobId}`,
    `Target org: ${orgContext.displayName} (${orgContext.expectedOrgId})`,
    `Environment: ${orgContext.environment}`,
    `Requirement: ${plan.requirementSummary || 'See issue details.'}`,
    `What will be delivered: ${plan.proposedImplementation}`,
    'Implementation steps:',
    ...steps,
    `Expected outcome: ${plan.expectedOutcome || 'See the Salesforce AI Agent console.'}`,
    `Business impact: ${plan.businessImpact || 'Limited to the approved requirement.'}`,
    `Risk: ${plan.estimatedRiskLevel}`,
    `Plan version: ${plan.planVersion}`,
    plan.notice || 'No changes have been made yet.',
    'Review and approve implementation in the Salesforce AI Agent console.'
  ].join('\n');
}
function noChangeCompletionComment(job, validation) { return [`AI agent job ${job.jobId} completed without deployment.`, `Salesforce org: ${job.orgContext.displayName} (${job.orgContext.expectedOrgId})`, `Validation: ${validation.status} (${validation.validationId})`, `Result: No Salesforce source changes were proposed, so deployment was not required.`].join('\n'); }
function sfFailureMessage(result) {
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    if (parsed.message) return parsed.message;
  } catch {
    // Fall through to sanitized CLI output.
  }
  return result.stderr || 'Salesforce validation failed.';
}
