import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMetadataBaseline } from '../src/services/jobWorkspace.js';
import { assertImplementationBaselineEligibility } from '../src/services/agent.js';
import { stableHash } from '../src/utils/hash.js';

const MODIFY_PATH = 'force-app/main/default/flows/RD_Installment.flow-meta.xml';
const CREATE_PATH = 'force-app/main/default/objects/GiftTransaction/fields/Installment_Number__c.field-meta.xml';
const DELETE_PATH = 'force-app/main/default/permissionsets/Legacy_Gift_Access.permissionset-meta.xml';
const SOURCE_ORG_ID = '00Dg500000E07e9EAB';

test('captures exact MODIFY source, explicit CREATE absence, and commits before eligibility', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'providus-baseline-'));
  const calls = [];
  const git = fakeGit(calls);
  try {
    const result = await captureMetadataBaseline({
      projectRoot,
      trustedSourceOrgId: SOURCE_ORG_ID,
      operations: [
        { operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', path: CREATE_PATH },
        { operation: 'modify', metadataType: 'Flow', apiName: 'RD_Installment', path: MODIFY_PATH }
      ],
      retrieve: async (components) => {
        calls.push(['retrieve', components]);
        await mkdir(join(projectRoot, MODIFY_PATH, '..'), { recursive: true });
        await writeFile(join(projectRoot, MODIFY_PATH), '<Flow>baseline</Flow>', 'utf8');
        return retrievalSuccess(components);
      },
      runGitCommand: git.run
    });

    assert.deepEqual(calls.map(([name]) => name), ['retrieve', 'status-before', 'add', 'commit', 'status-after', 'rev-parse']);
    assert.deepEqual(calls[0][1], [
      { type: 'Flow', apiName: 'RD_Installment' },
      { type: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c' }
    ]);
    assert.equal(result.baselineCommit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.deepEqual(result.files.map(({ path, state }) => ({ path, state })), [
      { path: MODIFY_PATH, state: 'PRESENT' },
      { path: CREATE_PATH, state: 'ABSENT' }
    ]);
    assert.match(result.files[0].hash, /^[a-f0-9]{64}$/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('requires MODIFY and DELETE source but distinguishes successful CREATE absence from retrieval failure', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'providus-baseline-'));
  try {
    for (const operation of ['modify', 'delete']) {
      await assert.rejects(
        captureMetadataBaseline({
          projectRoot,
          trustedSourceOrgId: SOURCE_ORG_ID,
          operations: [{ operation, metadataType: 'Flow', apiName: 'RD_Installment', path: MODIFY_PATH }],
          retrieve: async (components) => retrievalSuccess(components),
          runGitCommand: fakeGit([]).run
        }),
        (error) => error.code === 'BASELINE_COMPONENT_MISSING'
      );
    }
    await assert.rejects(
      captureMetadataBaseline({
        projectRoot,
        trustedSourceOrgId: SOURCE_ORG_ID,
        operations: [{ operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', path: CREATE_PATH }],
        retrieve: async () => ({ exitCode: 1, stdout: '', stderr: 'secret diagnostic' }),
        runGitCommand: fakeGit([]).run
      }),
      (error) => error.code === 'BASELINE_RETRIEVAL_FAILED' && !error.message.includes('secret diagnostic')
    );
    await assert.rejects(
      captureMetadataBaseline({
        projectRoot,
        trustedSourceOrgId: SOURCE_ORG_ID,
        operations: [{ operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', path: CREATE_PATH }],
        retrieve: async (components) => {
          await mkdir(join(projectRoot, CREATE_PATH, '..'), { recursive: true });
          await writeFile(join(projectRoot, CREATE_PATH), '<CustomField />', 'utf8');
          return retrievalSuccess(components);
        },
        runGitCommand: fakeGit([]).run
      }),
      (error) => error.code === 'BASELINE_COMPONENT_ALREADY_EXISTS'
    );
    for (const evidencePatch of [
      { sourceOrgId: '00Dg500000E07fAEAR' },
      { componentKeys: ['Flow:Other'] }
    ]) {
      await assert.rejects(
        captureMetadataBaseline({
          projectRoot,
          trustedSourceOrgId: SOURCE_ORG_ID,
          operations: [{ operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', path: CREATE_PATH }],
          retrieve: async (components) => ({ ...retrievalSuccess(components), ...evidencePatch }),
          runGitCommand: fakeGit([]).run
        }),
        (error) => error.code === 'BASELINE_RETRIEVAL_FAILED'
      );
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('fails closed on workspace contamination and never commits it', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'providus-baseline-'));
  const calls = [];
  try {
    await assert.rejects(
      captureMetadataBaseline({
        projectRoot,
        trustedSourceOrgId: SOURCE_ORG_ID,
        operations: [{ operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', path: CREATE_PATH }],
        retrieve: async (components) => retrievalSuccess(components),
        runGitCommand: fakeGit(calls, { contaminated: true }).run
      }),
      (error) => error.code === 'BASELINE_WORKTREE_CONTAMINATED'
    );
    assert.equal(calls.some(([name]) => name === 'commit'), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('captures exact existing DELETE source before any later deletion', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'providus-baseline-'));
  try {
    const result = await captureMetadataBaseline({
      projectRoot,
      trustedSourceOrgId: SOURCE_ORG_ID,
      operations: [{ operation: 'delete', metadataType: 'PermissionSet', apiName: 'Legacy_Gift_Access', path: DELETE_PATH }],
      retrieve: async (components) => {
        await mkdir(join(projectRoot, DELETE_PATH, '..'), { recursive: true });
        await writeFile(join(projectRoot, DELETE_PATH), '<PermissionSet />', 'utf8');
        return retrievalSuccess(components);
      },
      runGitCommand: fakeGitForPath([], DELETE_PATH).run
    });
    assert.equal(result.files[0].state, 'PRESENT');
    assert.match(result.files[0].hash, /^[a-f0-9]{64}$/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('requires a current Task 9 source, plan, scope, inspection, operation-set, and exact-org binding', () => {
  const operations = [{ operation: 'modify', metadataType: 'Flow', apiName: 'RD_Installment', path: MODIFY_PATH, content: '<Flow />' }];
  const sourceValidation = {
    status: 'PASSED', sourceHash: stableHash(operations), operationCount: 1, validatedPaths: [MODIFY_PATH],
    sourceOrgId: '00Dg500000E07e9EAB', inspectionHash: 'inspection', planHash: 'plan', scopeHash: 'scope'
  };
  const job = {
    status: 'IMPLEMENTING',
    orgId: '00Dg500000E07e9EAB', orgContext: { expectedOrgId: '00Dg500000E07e9EAB' },
    inspection: { hash: 'inspection' }, metadataScope: { hash: 'scope' },
    plan: { planHash: 'plan', scopeHash: 'scope', trustedBinding: { sourceOrgId: '00Dg500000E07e9EAB' }, components: [{ metadataType: 'Flow', apiName: 'RD_Installment' }] },
    sourceValidation,
    specialistResults: { FLOW: { operations } }
  };
  assert.doesNotThrow(() => assertImplementationBaselineEligibility(job, operations));
  for (const stale of [
    { sourceValidation: { ...sourceValidation, status: 'FAILED' } },
    { sourceValidation: { ...sourceValidation, sourceHash: '0'.repeat(64) } },
    { sourceValidation: { ...sourceValidation, planHash: 'changed' } },
    { sourceValidation: { ...sourceValidation, scopeHash: 'changed' } },
    { sourceValidation: { ...sourceValidation, inspectionHash: 'changed' } },
    { sourceValidation: { ...sourceValidation, sourceOrgId: '00Dg500000E07fAEAR' } },
    { status: 'CANCELLED' },
    { specialistResults: {} },
    { specialistResults: { FLOW: { operations: [{ ...operations[0], content: '<Flow>changed</Flow>' }] } } }
  ]) {
    assert.throws(
      () => assertImplementationBaselineEligibility({ ...job, ...stale }, operations),
      (error) => error.code === 'BASELINE_SOURCE_VALIDATION_STALE'
    );
  }
});

test('accepts persisted specialist operations in execution order after deterministic Task 9 sorting', () => {
  const flow = { operation: 'modify', metadataType: 'Flow', apiName: 'RD_Installment', path: MODIFY_PATH, content: '<Flow />' };
  const field = { operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', path: CREATE_PATH, content: '<CustomField />' };
  const operations = [field, flow];
  const job = {
    status: 'IMPLEMENTING', orgId: '00Dg500000E07e9EAB', orgContext: { expectedOrgId: '00Dg500000E07e9EAB' },
    inspection: { hash: 'inspection' }, metadataScope: { hash: 'scope' },
    plan: {
      planHash: 'plan', scopeHash: 'scope', trustedBinding: { sourceOrgId: '00Dg500000E07e9EAB' },
      components: [{ metadataType: 'Flow', apiName: 'RD_Installment' }, { metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c' }]
    },
    sourceValidation: {
      status: 'PASSED', sourceHash: stableHash(operations), operationCount: 2, validatedPaths: operations.map((operation) => operation.path),
      sourceOrgId: '00Dg500000E07e9EAB', inspectionHash: 'inspection', planHash: 'plan', scopeHash: 'scope'
    },
    specialistResults: { FLOW: { operations: [flow] }, OBJECT_FIELD: { operations: [field] } }
  };
  assert.doesNotThrow(() => assertImplementationBaselineEligibility(job, operations));
});

function retrievalSuccess(components) {
  return {
    exitCode: 0,
    stdout: '{"status":0}',
    stderr: '',
    sourceOrgId: SOURCE_ORG_ID,
    componentKeys: components.map(({ type, apiName }) => `${type}:${apiName}`)
  };
}

function fakeGit(calls, { contaminated = false } = {}) {
  return fakeGitForPath(calls, MODIFY_PATH, { contaminated });
}

function fakeGitForPath(calls, changedPath, { contaminated = false } = {}) {
  let statusCalls = 0;
  return {
    async run(command, params) {
      if (command === 'status') {
        statusCalls += 1;
        calls.push([statusCalls === 1 ? 'status-before' : 'status-after']);
        if (statusCalls === 1 && contaminated) return { exitCode: 0, stdout: '?? unrelated.txt\n', stderr: '' };
        if (statusCalls === 1) return { exitCode: 0, stdout: ` D ${changedPath}\n`, stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      calls.push([command, params]);
      if (command === 'rev-parse') return { exitCode: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  };
}
