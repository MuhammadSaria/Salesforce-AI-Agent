import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { createPostgresJobStore } from '../src/persistence/jobStore.js';
import { migrate } from '../src/persistence/migrate.js';
import { processAgentJob, setDirectAnalysisDependenciesForTest, setDirectSpecialistModelRunnerForTest, setSameOrgResolverForTest } from '../src/services/agent.js';
import { architecturePlanHashes } from '../src/domain/architecturePlan.js';
import { canonicalInspectionHash } from '../src/domain/inspection.js';
import { connectedFlowXml } from './fixtures/connectedFlow.js';
import { createTestPostgresPool, resetPostgresSchema } from './helpers/postgres.js';

const ORG = '00Dg500000E07e9EAB';
const USER = '005g5000009ImIkAAK';

test('separate API and worker PostgreSQL stores execute Task 8 without source or Salesforce side effects', async (t) => {
  const pool = createTestPostgresPool();
  await resetPostgresSchema(pool); await migrate(pool);
  t.after(() => pool.end());
  const apiStore = createPostgresJobStore({ pool, claimantId: 'api-instance', dispatchRetryBaseMs: 1 });
  const workerStore = createPostgresJobStore({ pool, claimantId: 'worker-instance', dispatchRetryBaseMs: 1 });
  const orgContext = { expectedOrgId: ORG, actualOrgId: ORG, orgRegistryId: 'direct', environment: 'sandbox', observedAt: new Date().toISOString(), verified: { organizationId: ORG, verifiedAt: new Date().toISOString() } };
  const queued = [];
  const sameOrg = async () => orgContext;
  const oldToken = config.apiAuthToken; config.apiAuthToken = 'two-instance-token';
  setSameOrgResolverForTest(sameOrg);
  setDirectAnalysisDependenciesForTest({ inspectFlowRequirement: async () => inspection(), createArchitecturePlan: async () => plan(inspection()) });
  setDirectSpecialistModelRunnerForTest(async ({ specialistId }) => resultFor(specialistId));
  let redisAvailable = true;
  const app = createApp({ jobStore: apiStore, resolveSameOrg: sameOrg, enqueue: async (message) => { if (!redisAvailable) throw new Error('redis unavailable'); queued.push(message); } });
  const server = app.listen(0); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.close(); config.apiAuthToken = oldToken; setSameOrgResolverForTest(); setDirectAnalysisDependenciesForTest(); setDirectSpecialistModelRunnerForTest(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await post(`${base}/api/jobs`, { prompt: 'Number completed recurring donations.' }, headers(false));
  assert.equal(created.status, 201);
  await processAgentJob(queued.shift(), { jobStore: workerStore });
  let job = await apiStore.get(created.body.jobId);
  assert.equal(job.status, 'AWAITING_IMPLEMENTATION_APPROVAL');

  redisAvailable = false;
  const approved = await post(`${base}/api/jobs/${job.jobId}/approve-implementation`, { planVersion: 1, planHash: job.plan.planHash, scopeHash: job.plan.scopeHash }, headers(true));
  assert.equal(approved.status, 201);
  job = await workerStore.get(job.jobId);
  assert.equal(job.approvals.length, 1);
  assert.equal(job.dispatches.length, 1);
  assert.equal(job.dispatches[0].status, 'RETRYABLE');
  assert.deepEqual(job.commands, []);

  await pool.query("UPDATE job_dispatches SET next_attempt_at=now()-interval '1 second' WHERE job_id=$1", [job.jobId]);
  const dispatch = await workerStore.claimNextDispatch();
  await processAgentJob({ jobId: dispatch.jobId, action: dispatch.action, actor: dispatch.actor }, { jobStore: workerStore });
  await workerStore.markDispatchDelivered(dispatch.dispatchKey);
  const finalApi = await apiStore.get(job.jobId);
  const finalWorker = await workerStore.get(job.jobId);
  assert.deepEqual(Object.keys(finalApi.specialistResults).sort(), ['FLOW', 'OBJECT_FIELD', 'SECURITY_PERMISSIONS']);
  assert.deepEqual(finalApi.specialistResults, finalWorker.specialistResults);
  assert.equal(finalApi.dispatches[0].status, 'DELIVERED');
  assert.ok(finalApi.conversation.length && finalApi.inspection && finalApi.plan && finalApi.stateHistory.length && finalApi.logs.length);
  assert.equal(finalApi.revision, finalWorker.revision);
  assert.equal(Boolean(finalApi.implementation), false);
  assert.equal(Boolean(finalApi.validation), false);
  assert.equal(Boolean(finalApi.deployment), false);
  assert.deepEqual(finalApi.commands, []);
});

function inspection() {
  const now = new Date().toISOString();
  const body = { sourceOrgId: ORG, evidence: [
    { evidenceId: 'object', kind: 'OBJECT', componentType: 'CustomObject', componentApiName: 'GiftTransaction', sourceOrgId: ORG, active: true, stale: false, observedAt: now },
    { evidenceId: 'field', kind: 'FIELD', objectApiName: 'GiftTransaction', fieldApiName: 'Installment_Number__c', componentType: 'CustomField', componentApiName: 'GiftTransaction.Installment_Number__c', sourceOrgId: ORG, active: true, stale: false, observedAt: now },
    { evidenceId: 'relationship', kind: 'RELATIONSHIP', objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', targetObjectApiName: 'GiftCommitment', componentType: 'CustomField', componentApiName: 'GiftTransaction.GiftCommitmentId', sourceOrgId: ORG, active: true, stale: false, observedAt: now },
    { evidenceId: 'status', kind: 'STATUS_VALUE', objectApiName: 'GiftTransaction', fieldApiName: 'Status', value: 'Completed', componentType: 'CustomField', componentApiName: 'GiftTransaction.Status', sourceOrgId: ORG, active: true, stale: false, observedAt: now }
  ], objects: [{ apiName: 'GiftTransaction' }], relationships: [{ objectApiName: 'GiftTransaction', fieldApiName: 'GiftCommitmentId', referenceTo: 'GiftCommitment' }], ambiguities: [] };
  return { ...body, hash: canonicalInspectionHash(body) };
}
function plan(current) {
  const core = { requirement: 'Number completed recurring donations.', acceptanceCriteria: ['Best-effort sequential numbering.'], assumptions: [], evidenceIds: ['object', 'field', 'relationship', 'status'], components: [
    { operation: 'create', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', owner: 'object-field-specialist', reason: 'Store number.' },
    { operation: 'modify', metadataType: 'PermissionSet', apiName: 'Gift_Operations', owner: 'security-specialist', reason: 'Grant field access.' },
    { operation: 'modify', metadataType: 'Flow', apiName: 'Assign_Installment', owner: 'flow-specialist', reason: 'Assign number.' }
  ], expectedBehavior: ['Create and update completed records without overwrite.'], testingStrategy: ['Task 9 validation.'], risks: ['Highest plus one cannot guarantee strict uniqueness under concurrent processing.'], rollbackStrategy: 'Keep Draft.', trustedBinding: { inspectionHash: current.hash, sourceOrgId: ORG }, planVersion: 1 };
  const hashes = architecturePlanHashes(core); return { ...core, ...hashes, materialChangeHash: hashes.scopeHash };
}
function resultFor(id) {
  if (id === 'OBJECT_FIELD') return complete({ operation: 'create', path: 'force-app/main/default/objects/GiftTransaction/fields/Installment_Number__c.field-meta.xml', metadataType: 'CustomField', apiName: 'GiftTransaction.Installment_Number__c', reason: 'Store number.', content: '<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Installment_Number__c</fullName><label>Installment Number</label><precision>18</precision><scale>0</scale><type>Number</type></CustomField>' });
  if (id === 'SECURITY_PERMISSIONS') return complete({ operation: 'modify', path: 'force-app/main/default/permissionsets/Gift_Operations.permissionset-meta.xml', metadataType: 'PermissionSet', apiName: 'Gift_Operations', reason: 'Grant field.', content: '<?xml version="1.0" encoding="UTF-8"?><PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><fieldPermissions><field>GiftTransaction.Installment_Number__c</field><readable>true</readable><editable>true</editable></fieldPermissions></PermissionSet>' });
  return complete({ operation: 'modify', path: 'force-app/main/default/flows/Assign_Installment.flow-meta.xml', metadataType: 'Flow', apiName: 'Assign_Installment', reason: 'Assign number.', content: connectedFlowXml() }, ['Highest plus one cannot guarantee strict uniqueness under concurrent processing.']);
}
function complete(operation, risks = []) { return { status: 'COMPLETED', operations: [operation], dependencies: [], risks, verification: ['Generated only in memory.'] }; }
function headers(canImplement) { return { Authorization: 'Bearer two-instance-token', 'Content-Type': 'application/json', 'X-Agent-Source': 'Salesforce-Apex', 'X-Agent-Org-Id': ORG, 'X-Agent-User-Id': USER, 'X-Agent-Can-Implement': String(canImplement), 'X-Agent-Can-Deploy': 'false' }; }
async function post(url, body, requestHeaders) { const response = await fetch(url, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
