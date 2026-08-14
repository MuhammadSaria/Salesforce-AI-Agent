import test from 'node:test';
import assert from 'node:assert/strict';
import { nanoid } from 'nanoid';
import { createTestPostgresPool } from './helpers/postgres.js';
import { migrate } from '../src/persistence/migrate.js';
import { createPostgresJobStore } from '../src/persistence/jobStore.js';
import { buildDataOperationApproval, buildDeploymentApproval } from '../src/services/phase1Deployment.js';

const ORG = '00Dg500000E07e9EAB';
const HASH = Object.freeze({ plan: '1'.repeat(64), scope: '2'.repeat(64), inspection: '3'.repeat(64), source: '4'.repeat(64), package: '5'.repeat(64), commit: '6'.repeat(40), baseline: '7'.repeat(40), preview: '8'.repeat(64) });

test('PostgreSQL preserves exact deployment and data approvals across store instances', async (t) => {
  const pool = createTestPostgresPool();
  await migrate(pool);
  t.after(() => pool.end());
  const storeA = createPostgresJobStore({ pool, claimantId: `task12-a-${nanoid()}` });
  const storeB = createPostgresJobStore({ pool, claimantId: `task12-b-${nanoid()}` });
  const jobId = `task12-persist-${nanoid()}`;
  await storeA.create({ jobId, userId: '005-admin', orgId: ORG, source: 'salesforce-chat', prompt: 'Deploy exact inactive Flow' });
  await storeA.update(jobId, deploymentPatch(jobId));

  await storeA.updateAtomically(jobId, (record) => {
    const deployment = buildDeploymentApproval(record, { approvalId: 'deployment-approval', actorId: '005-deployer' });
    const data = buildDataOperationApproval(record, record.dataPreview, { approvalId: 'data-approval', actorId: '005-admin' });
    record.approvals = [...record.approvals, deployment, data];
  });

  const restarted = await storeB.get(jobId);
  assert.deepEqual(restarted.approvals.map((approval) => approval.approvalType), ['DEPLOYMENT', 'DATA_OPERATION']);
  assert.equal(restarted.approvals[0].packageHash, HASH.package);
  assert.equal(restarted.approvals[0].validationId, 'validation-1');
  assert.equal(restarted.approvals[1].previewHash, HASH.preview);
  assert.equal(restarted.approvals[1].recordCount, 11);
});

function deploymentPatch(jobId) {
  const timestamp = new Date().toISOString();
  const expiryTimestamp = new Date(Date.now() + 60000).toISOString();
  return {
    status: 'AWAITING_DEPLOYMENT_APPROVAL',
    plan: { planVersion: 1, planHash: HASH.plan, scopeHash: HASH.scope, trustedBinding: { sourceOrgId: ORG, inspectionHash: HASH.inspection } },
    metadataScope: { hash: HASH.scope }, inspection: { hash: HASH.inspection },
    sourceValidation: { status: 'PASSED', sourceHash: HASH.source, sourceOrgId: ORG, planHash: HASH.plan, scopeHash: HASH.scope, inspectionHash: HASH.inspection },
    implementationBaseline: { status: 'CAPTURED', baselineCommit: HASH.baseline, sourceHash: HASH.source, sourceOrgId: ORG, planHash: HASH.plan, scopeHash: HASH.scope, inspectionHash: HASH.inspection },
    implementation: { baselineCommit: HASH.baseline, sourceHash: HASH.source, packageHash: HASH.package, commitHash: HASH.commit },
    validation: { validationId: 'validation-1', status: 'PASSED', targetOrgId: ORG, sourceHash: HASH.source, packageHash: HASH.package, commitHash: HASH.commit, baselineCommit: HASH.baseline, planHash: HASH.plan, scopeHash: HASH.scope, inspectionHash: HASH.inspection, timestamp, expiryTimestamp },
    dataPreview: { jobId, salesforceOrganizationId: ORG, scopeHash: HASH.scope, operationId: 'update:Account:selection', recordCount: 11, previewHash: HASH.preview, expiresAt: expiryTimestamp },
    approvals: []
  };
}
