import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { promisify } from 'node:util';
import { createApp } from '../src/server.js';
import * as workerModule from '../src/worker.js';
import { config } from '../src/config.js';
import { createPostgresJobStore } from '../src/persistence/jobStore.js';
import { migrate } from '../src/persistence/migrate.js';
import { resolveSameOrg } from '../src/services/sameOrgService.js';
import { canonicalInspectionHash } from '../src/domain/inspection.js';
import { runGit } from '../src/services/gitExecutor.js';
import { connectedFlowXml } from './fixtures/connectedFlow.js';
import { createTestPostgresPool, resetPostgresSchema } from './helpers/postgres.js';

const run = promisify(execFile);
const ORG_ID = '00Dg500000E07e9EAB';
const USER_ID = '005g5000009ImIkAAK';
const API_TOKEN = 'task-14-acceptance-token';
const VALIDATION_ID = '0Af000000000001AAA';
const DEPLOYMENT_ID = '0Af000000000002AAA';

test('direct recurring-donation request reaches an exact validated inactive deployment truthfully', async (t) => {
  assert.equal(
    typeof workerModule.createWorkerRuntime,
    'function',
    'worker must expose production dependency injection for the complete Phase 1 runtime'
  );

  const harness = await createAcceptanceHarness(t);
  const job = await harness.createJob('Number each completed Donation for its Recurring Donation.');

  const clarification = await harness.waitFor(job.jobId, 'AWAITING_CLARIFICATION');
  assert.equal(clarification.clarifications.filter((item) => item.status === 'OPEN').length, 1);
  assert.equal(
    clarification.clarifications.find((item) => item.status === 'OPEN').inspectionHash,
    canonicalInspectionHash(clarification.inspection),
    'the persisted clarification must remain bound to the canonical inspection evidence'
  );
  await harness.answerMaterialQuestions(job.jobId, {
    qualifyingStatus: 'Completed',
    reversalPolicy: 'retain',
    numberingRule: 'highest-plus-one'
  });

  const plan = await harness.waitFor(job.jobId, 'AWAITING_IMPLEMENTATION_APPROVAL');
  assert.deepEqual(plan.components.map((item) => item.metadataType), ['CustomField', 'PermissionSet', 'Flow']);

  await harness.approveImplementation(job.jobId);
  const validated = await harness.waitFor(job.jobId, 'AWAITING_DEPLOYMENT_APPROVAL');
  assert.equal(validated.validation.status, 'SUCCEEDED');
  assert.match(validated.generatedFlow, /<status>Draft<\/status>/);
  assert.doesNotMatch(validated.generatedFlow, /<status>Active<\/status>/);
  assert.equal(validated.sourceValidation.status, 'PASSED');
  assert.equal(validated.sourceValidation.operationCount, 3);
  assert.ok(validated.sourceValidation.sourceHash);
  assert.ok(validated.implementationBaseline.baselineCommit);
  assert.equal(validated.implementationBaseline.sourceWritten, false);
  assert.ok(validated.implementation.lockToken);
  assert.equal(harness.salesforce.deployCalls, 0);

  const premature = await harness.request('POST', `/api/jobs/${job.jobId}/deploy`, {});
  assert.equal(premature.status, 409);
  assert.equal(harness.salesforce.deployCalls, 0);

  await harness.approveDeployment(job.jobId);
  const completed = await harness.waitFor(job.jobId, 'COMPLETED');
  assert.equal(completed.deployment.activated, false);
  assert.equal(completed.jira, undefined);
  assert.ok(completed.reportId);
  assert.ok(completed.baselineCommit);
  assert.equal(completed.baselineCommit, completed.implementationBaseline.baselineCommit);
  assert.equal(completed.deployment.validationId, VALIDATION_ID);
  assert.equal(completed.deployment.deploymentId, DEPLOYMENT_ID);
  assert.equal(completed.deployment.sourceHash, completed.validation.sourceHash);
  assert.equal(completed.deployment.packageHash, completed.validation.packageHash);
  assert.equal(completed.deployment.commitHash, completed.validation.commitHash);
  assert.equal(harness.salesforce.deployCalls, 1);
  assert.equal(completed.conversation.some((entry) => /jira/i.test(entry.text)), false);
  assert.match(completed.implementationReport.summary, /deployed inactive/i);
  assert.doesNotMatch(completed.implementationReport.summary, /activated/i);
});

async function createAcceptanceHarness(t) {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/recurring-donation-inspection.json', import.meta.url), 'utf8'));
  const pool = createTestPostgresPool();
  await resetPostgresSchema(pool);
  await migrate(pool);
  const apiStore = createPostgresJobStore({ pool, claimantId: 'task-14-api', dispatchRetryBaseMs: 1 });
  const workerStore = createPostgresJobStore({ pool, claimantId: 'task-14-worker', dispatchRetryBaseMs: 1 });
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'providus-task-14-'));
  const projectRoot = join(workspaceRoot, 'source-repository');
  await initializeGitRepository(projectRoot);

  const oldConfig = {
    apiAuthToken: config.apiAuthToken,
    workspaceRoot: config.workspaceRoot,
    projectRoot: config.projectRoot,
    jiraEnabled: config.jiraEnabled
  };
  config.apiAuthToken = API_TOKEN;
  config.workspaceRoot = workspaceRoot;
  config.projectRoot = projectRoot;
  config.jiraEnabled = false;

  const observed = {
    ...fixture.verifiedOrg,
    verifiedAt: new Date().toISOString(),
    isSandbox: true,
    isProduction: false
  };
  const registryOrg = {
    id: 'providus-phase1-sandbox',
    displayName: 'Providus Phase 1 Sandbox',
    customerName: 'Providus',
    active: true,
    authenticationStatus: 'connected',
    salesforceAlias: 'providus-phase1',
    expectedOrgId: ORG_ID,
    expectedUsername: observed.username,
    instanceUrl: observed.instanceUrl,
    environment: 'sandbox',
    deploymentPermission: 'allowed',
    dataMutationPermission: 'blocked',
    recordDeletionPermission: 'blocked',
    allowedDataObjects: [],
    restrictedDataObjects: [],
    maximumDataOperations: 10,
    maximumDeleteOperations: 0,
    productionApprovalRequired: false,
    allowedOperations: ['retrieve', 'query', 'deploy'],
    allowedMetadataTypes: ['CustomObject', 'CustomField', 'PermissionSet', 'Flow'],
    restrictedMetadataTypes: []
  };
  const sameOrgResolver = ({ authenticatedOrgId, actorId }) => resolveSameOrg({
    authenticatedOrgId,
    actorId,
    registryOrgs: [registryOrg],
    observed: { ...observed, verifiedAt: new Date().toISOString() }
  });
  const salesforce = salesforceBoundary(fixture);
  const modelRunner = modelBoundary(fixture);
  const gitTrace = [];
  const tracedGit = async (command, params) => {
    const result = await runGit(command, params);
    gitTrace.push({ command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    return result;
  };
  const runtime = workerModule.createWorkerRuntime({
    jobStore: workerStore,
    sameOrgResolver,
    inspectionDependencies: { sf: salesforce.inspection },
    architecturePlannerDependencies: { modelRunner },
    specialistModelRunner: modelRunner,
    salesforceExecutor: salesforce.executor,
    runGit: tracedGit
  });
  const queued = [];
  const enqueue = async (message) => { queued.push(message); return { id: `${message.jobId}:${message.action}` }; };
  const app = createApp({ jobStore: apiStore, resolveSameOrg: sameOrgResolver, enqueue });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    config.apiAuthToken = oldConfig.apiAuthToken;
    config.workspaceRoot = oldConfig.workspaceRoot;
    config.projectRoot = oldConfig.projectRoot;
    config.jiraEnabled = oldConfig.jiraEnabled;
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const request = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: requestHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
  const drain = async () => {
    while (queued.length) await runtime.process(queued.shift());
  };
  const persisted = async (jobId) => {
    const current = await apiStore.get(jobId);
    const flow = Object.values(current.specialistResults || {}).flatMap((result) => result.operations || [])
      .find((operation) => operation.metadataType === 'Flow');
    return { ...current, components: current.plan?.components || [], generatedFlow: flow?.content || '' };
  };

  return {
    salesforce,
    request,
    async createJob(prompt) {
      const result = await request('POST', '/api/jobs', { prompt });
      assert.equal(result.status, 201);
      await drain();
      return result.body;
    },
    async answerMaterialQuestions(jobId, answers) {
      const text = `qualifyingStatus=${answers.qualifyingStatus}; reversalPolicy=${answers.reversalPolicy}; numberingRule=${answers.numberingRule}`;
      const result = await request('POST', `/api/jobs/${jobId}/messages`, { text });
      assert.equal(result.status, 202);
      await drain();
    },
    async approveImplementation(jobId) {
      const current = await persisted(jobId);
      const result = await request('POST', `/api/jobs/${jobId}/approve-implementation`, {
        planVersion: current.plan.planVersion,
        planHash: current.plan.planHash,
        scopeHash: current.plan.scopeHash
      });
      assert.equal(result.status, 201);
      try { await drain(); } catch (error) {
        error.message = `${error.message} Git trace: ${JSON.stringify(gitTrace)}`;
        throw error;
      }
    },
    async approveDeployment(jobId) {
      const current = await persisted(jobId);
      const approval = await request('POST', `/api/jobs/${jobId}/approve-deployment`, {
        validationId: current.validation.validationId
      });
      assert.equal(approval.status, 201);
      const deployment = await request('POST', `/api/jobs/${jobId}/deploy`, {});
      assert.equal(deployment.status, 202);
      await drain();
    },
    async waitFor(jobId, status) {
      const current = await persisted(jobId);
      assert.equal(current.status, status, JSON.stringify({
        actualStatus: current.status,
        error: current.error,
        lastLog: current.logs?.at(-1)?.message,
        modelCalls: modelRunner.calls,
        gitTrace,
        openClarifications: (current.clarifications || []).filter((item) => item.status === 'OPEN').map((item) => ({ ambiguityId: item.ambiguityId, question: item.question })),
        conversationKinds: (current.conversation || []).map((item) => item.kind)
      }));
      return current;
    }
  };
}

function salesforceBoundary(fixture) {
  let deployCalls = 0;
  const query = async ({ operationId }) => {
    let records = [];
    if (operationId === 'object-candidates') {
      records = fixture.objects.map((item) => ({ DurableId: item.apiName, QualifiedApiName: item.apiName, Label: item.label }));
    } else if (operationId.startsWith('field-definition-exact:')) {
      const identity = operationId.slice('field-definition-exact:'.length);
      const field = fixture.fields.find((item) => `${item.objectApiName}.${item.apiName}` === identity);
      if (field) records = [{
        EntityDefinition: { QualifiedApiName: field.objectApiName },
        QualifiedApiName: field.apiName,
        Label: field.label,
        DataType: field.dataType,
        RelationshipName: field.relationshipName || '',
        ReferenceTo: field.referenceTo ? [field.referenceTo] : null
      }];
    } else if (operationId.startsWith('picklist-values:')) {
      records = fixture.statusValues.map((item) => ({
        EntityParticle: { EntityDefinition: { QualifiedApiName: item.objectApiName }, QualifiedApiName: item.fieldApiName },
        Value: item.value,
        Label: item.label,
        IsActive: item.active
      }));
    }
    return { exitCode: 0, stdout: JSON.stringify({ status: 0, result: { records } }), stderr: '' };
  };
  const inspection = {
    query,
    verifyOrg: async () => fixture.verifiedOrg,
    retrieveMetadata: async ({ components }) => ({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        status: 0,
        result: {
          done: true,
          status: 'Succeeded',
          files: components.map((component) => ({ type: component.type, fullName: component.apiName, state: 'Unchanged' }))
        }
      })
    })
  };
  const executor = {
    verifySelectedOrg: async () => ({ ...fixture.verifiedOrg, verifiedAt: new Date().toISOString() }),
    runSfCommand: async (command) => {
      if (command === 'retrieveMetadata') return { exitCode: 0, stdout: JSON.stringify({ status: 0, warnings: [] }), stderr: '', command: 'sf project retrieve start' };
      if (command === 'deployDryRun') return { exitCode: 0, stdout: JSON.stringify({ status: 0, result: { id: VALIDATION_ID, status: 'Succeeded' } }), stderr: '', command: 'sf project deploy start --dry-run' };
      if (command === 'deployValidated') {
        deployCalls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ status: 0, result: { id: DEPLOYMENT_ID, status: 'Succeeded' } }), stderr: '', command: 'sf project deploy quick' };
      }
      throw new Error(`Unexpected Salesforce command in acceptance boundary: ${command}`);
    }
  };
  return { inspection, executor, get deployCalls() { return deployCalls; } };
}

function modelBoundary(fixture) {
  const calls = [];
  const runner = async (input) => {
    calls.push(input.specialistId || 'ARCHITECTURE');
    if (!input.specialistId) {
      const answers = (input.answers || []).map((item) => item.text || item).join(' ');
      if (!/qualifyingStatus=Completed/i.test(answers) || !/reversalPolicy=retain/i.test(answers) || !/numberingRule=highest-plus-one/i.test(answers)) {
        throw Object.assign(new Error('Confirm the qualifying status, reversal policy, and numbering rule.'), {
          code: 'MATERIAL_CLARIFICATION_REQUIRED', ambiguityId: 'material:recurring-donation-policy'
        });
      }
      const components = fixture.expectedGeneratedComponents;
      return {
        requirement: 'Number each completed Donation for its Recurring Donation.',
        acceptanceCriteria: [
          'Completed Donations are numbered on create or transition without overwrite.',
          'Use same-parent highest-plus-one numbering and retain numbers after reversal.'
        ],
        assumptions: ['Highest-plus-one Flow numbering is best effort under concurrent completion.'],
        evidenceIds: fixture.approvedEvidenceIds,
        components: [
          { operation: 'create', ...components[0], owner: 'object-field-specialist', reason: 'Store the approved installment number.' },
          { operation: 'create', ...components[1], owner: 'security-specialist', reason: 'Grant least-privilege access to the approved field.' },
          { operation: 'create', ...components[2], owner: 'flow-specialist', reason: 'Assign the installment number for qualifying Donations.' }
        ],
        expectedBehavior: [
          'Number completed Donations for the same Recurring Donation using highest plus one.',
          'Assign one when no prior installment exists and never overwrite or historically renumber.',
          'Retain the assigned number if a Donation is later reversed.'
        ],
        testingStrategy: ['Run deterministic complete-set validation and Salesforce dry-run validation.'],
        risks: ['Highest plus one cannot guarantee strict uniqueness under concurrent processing.'],
        rollbackStrategy: 'Deploy the Flow in Draft and use the immutable baseline for rollback.'
      };
    }
    if (input.specialistId === 'OBJECT_FIELD') return completed(fieldOperation());
    if (input.specialistId === 'SECURITY_PERMISSIONS') return completed(permissionOperation());
    if (input.specialistId === 'FLOW') return completed(flowOperation(), ['Highest plus one cannot guarantee strict uniqueness under concurrent processing.']);
    throw new Error(`Unexpected model specialist: ${input.specialistId}`);
  };
  runner.calls = calls;
  return runner;
}

function fieldOperation() {
  return {
    operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c',
    path: 'force-app/main/default/objects/GiftTransaction/fields/Installment_Number__c.field-meta.xml',
    reason: 'Store the approved installment number.',
    content: '<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Installment_Number__c</fullName><label>Installment Number</label><precision>18</precision><scale>0</scale><type>Number</type></CustomField>'
  };
}

function permissionOperation() {
  return {
    operation: 'create', metadataType: 'PermissionSet', apiName: 'Providus_Recurring_Donation_Installments',
    path: 'force-app/main/default/permissionsets/Providus_Recurring_Donation_Installments.permissionset-meta.xml',
    reason: 'Grant least-privilege access to the installment field.',
    content: '<?xml version="1.0" encoding="UTF-8"?><PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><fieldPermissions><field>GiftTransaction.Installment_Number__c</field><readable>true</readable><editable>true</editable></fieldPermissions></PermissionSet>'
  };
}

function flowOperation() {
  const descriptions = [
    'CREATE_AS_COMPLETED', 'TRANSITION_TO_COMPLETED', 'ALREADY_NUMBERED_PROTECTION',
    'SAME_PARENT_LOOKUP', 'FIRST_INSTALLMENT_ONE', 'INCREMENT_N_PLUS_ONE',
    'REVERSAL_RETENTION', 'NO_HISTORICAL_RENUMBER', 'NO_OVERWRITE'
  ].map((value) => `<description>${value}</description>`).join('');
  const content = connectedFlowXml().replace(
    '</apiVersion>',
    `</apiVersion><label>Assign Recurring Donation Installment</label><processType>AutoLaunchedFlow</processType>${descriptions}`
  );
  return {
    operation: 'create', metadataType: 'Flow', apiName: 'Assign_Recurring_Donation_Installment',
    path: 'force-app/main/default/flows/Assign_Recurring_Donation_Installment.flow-meta.xml',
    reason: 'Assign the approved same-parent installment sequence.', content
  };
}

function completed(operation, risks = []) {
  return { status: 'COMPLETED', operations: [operation], dependencies: [], risks, verification: ['Complete executable metadata source generated.'] };
}

function requestHeaders() {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
    'X-Agent-Source': 'Salesforce-Apex',
    'X-Agent-Org-Id': ORG_ID,
    'X-Agent-User-Id': USER_ID,
    'X-Agent-Can-Implement': 'true',
    'X-Agent-Can-Deploy': 'true'
  };
}

async function initializeGitRepository(projectRoot) {
  await run('git', ['init', projectRoot]);
  await run('git', ['config', 'user.email', 'providus-tests@example.invalid'], { cwd: projectRoot });
  await run('git', ['config', 'user.name', 'Providus Test'], { cwd: projectRoot });
  await writeFile(join(projectRoot, 'README.md'), 'Providus Task 14 acceptance repository.\n', 'utf8');
  await run('git', ['add', 'README.md'], { cwd: projectRoot });
  await run('git', ['commit', '-m', 'test baseline'], { cwd: projectRoot });
}
