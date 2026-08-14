import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryJobStore } from '../src/persistence/jobStore.js';
import { createCorrectionRouter } from '../src/services/correctionRouting.js';
import { routeBoundedValidationFailureForJob, setCorrectionRouterForTest } from '../src/services/agent.js';

test('agent exposes one internal Task 11 routing seam without adding a deployment action', async (t) => {
  t.after(() => setCorrectionRouterForTest());
  let received;
  setCorrectionRouterForTest({
    async routeValidationFailure(input) { received = input; return { classification: 'INFRASTRUCTURE' }; }
  });
  const result = await routeBoundedValidationFailureForJob({ jobId: 'job-1', failure: { code: 'VALIDATION_TIMEOUT' } });
  assert.equal(result.classification, 'INFRASTRUCTURE');
  assert.equal(received.jobId, 'job-1');
});

test('routes mechanical evidence only to the bounded correction service', async () => {
  const { store, job } = await routingJob();
  let correctionCalls = 0;
  const router = createCorrectionRouter({
    jobStore: store,
    correctionService: {
      async correctMechanicalFailure(input) {
        correctionCalls += 1;
        assert.equal(input.owner, 'FLOW');
        return { attempt: 1, owner: 'FLOW', sourceWritten: false };
      }
    }
  });
  const result = await router.routeValidationFailure({
    job, failure: mechanicalFailure(), owner: 'FLOW', attempt: 1, lockToken: 'trusted-lock-token'
  });
  assert.equal(result.classification, 'MECHANICAL');
  assert.equal(correctionCalls, 1);
  assert.equal((await store.get(job.jobId)).status, 'VALIDATING');
});

test('correction limit exhaustion enters a recoverable failed lifecycle without a fourth source action', async () => {
  const { store, job } = await routingJob();
  let correctionCalls = 0;
  const router = createCorrectionRouter({
    jobStore: store,
    correctionService: {
      async correctMechanicalFailure() {
        correctionCalls += 1;
        throw Object.assign(new Error('limit'), { code: 'CORRECTION_LIMIT_REACHED' });
      }
    }
  });
  await store.update(job.jobId, { correctionAttempt: 3 });
  await assert.rejects(
    () => router.routeValidationFailure({ job, failure: mechanicalFailure(), owner: 'FLOW', attempt: 4 }),
    (error) => error.code === 'CORRECTION_LIMIT_REACHED'
  );
  assert.equal(correctionCalls, 1);
  assert.equal((await store.get(job.jobId)).status, 'FAILED');
});

test('material evidence invalidates stale approval and returns to clarification without a model call', async () => {
  const { store, job } = await routingJob();
  let correctionCalls = 0;
  const router = createCorrectionRouter({
    jobStore: store,
    correctionService: { async correctMechanicalFailure() { correctionCalls += 1; } }
  });
  const result = await router.routeValidationFailure({
    job,
    failure: { code: 'NEW_COMPONENT_REQUIRED', source: 'SOURCE_VALIDATION', details: { message: 'A new component is required.' } },
    owner: 'FLOW', attempt: 1, actor: '005-reviewer'
  });
  const updated = await store.get(job.jobId);
  assert.equal(result.classification, 'MATERIAL');
  assert.equal(updated.status, 'AWAITING_CLARIFICATION');
  assert.deepEqual(updated.approvals, []);
  assert.equal(updated.plan, null);
  assert.equal(updated.sourceValidation, null);
  assert.equal(updated.correctionAttempt, 0);
  assert.equal(updated.clarifications.length, 1);
  assert.equal(updated.revisions.at(-1).plan.planHash, 'plan-hash');
  assert.equal(correctionCalls, 0);
});

test('infrastructure evidence remains retryable without correction, replanning, attempt consumption, or source side effects', async () => {
  const { store, job } = await routingJob();
  let correctionCalls = 0;
  const router = createCorrectionRouter({
    jobStore: store,
    correctionService: { async correctMechanicalFailure() { correctionCalls += 1; } }
  });
  await assert.rejects(
    () => router.routeValidationFailure({
      job, failure: { code: 'VALIDATION_TIMEOUT', source: 'VALIDATION_INFRASTRUCTURE' }, owner: 'FLOW', attempt: 1
    }),
    (error) => error.code === 'VALIDATION_TIMEOUT' && error.retryable === true
  );
  const updated = await store.get(job.jobId);
  assert.equal(updated.status, job.status);
  assert.deepEqual(updated.approvals, job.approvals);
  assert.equal(updated.correctionAttempt, 0);
  assert.deepEqual(updated.specialistResults, job.specialistResults);
  assert.equal(correctionCalls, 0);
});

test('unknown evidence fails closed without correction or lifecycle mutation', async () => {
  const { store, job } = await routingJob();
  let correctionCalls = 0;
  const router = createCorrectionRouter({
    jobStore: store,
    correctionService: { async correctMechanicalFailure() { correctionCalls += 1; } }
  });
  await assert.rejects(
    () => router.routeValidationFailure({ job, failure: { code: 'MYSTERY', message: 'XML broke' }, owner: 'FLOW', attempt: 1 }),
    (error) => error.code === 'VALIDATION_FAILURE_UNCLASSIFIED'
  );
  assert.equal((await store.get(job.jobId)).status, job.status);
  assert.equal(correctionCalls, 0);
});

async function routingJob() {
  const store = createMemoryJobStore();
  const jobId = `routing-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await store.create({ jobId, source: 'salesforce-chat', orgId: '00Dg500000E07e9EAB', userId: '005-user', prompt: 'Approved requirement' });
  await store.update(jobId, {
    status: 'CORRECTING',
    plan: { planVersion: 1, planHash: 'plan-hash', scopeHash: 'scope-hash', components: [] },
    approvals: [{ type: 'IMPLEMENTATION', decision: 'APPROVED', planHash: 'plan-hash', scopeHash: 'scope-hash' }],
    sourceValidation: { status: 'PASSED', sourceHash: 'source-hash' },
    implementationBaseline: { status: 'CAPTURED', baselineCommit: 'aaaaaaaa' },
    specialistResults: { FLOW: { specialistId: 'FLOW', operations: [{ path: 'force-app/main/default/flows/Approved.flow-meta.xml' }] } },
    correctionAttempt: 0,
    correctionReservation: null,
    correctionHistory: []
  });
  return { store, job: await store.get(jobId) };
}

function mechanicalFailure() {
  return {
    code: 'METADATA_XML_MALFORMED', source: 'SOURCE_VALIDATION',
    component: { metadataType: 'Flow', apiName: 'Approved', path: 'force-app/main/default/flows/Approved.flow-meta.xml' }
  };
}
