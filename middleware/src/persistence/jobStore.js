import { AsyncLocalStorage } from 'node:async_hooks';
import {
  appendAudit,
  appendCommand,
  appendConversation,
  appendLog,
  claimFileOwnership,
  claimPendingDispatch,
  createJobRecord,
  getJobRecord,
  invalidateForOrgChange,
  invalidateForPlanChange,
  listJobRecords,
  listPendingDispatches,
  markDispatchDispatched,
  markDispatchPending,
  releaseFileOwnership,
  transitionJob,
  transitionWorkItem,
  updateJob,
  updateJobAtomically
} from '../services/jobStore.js';
import { createPostgresJobRecordStore } from './jobRecordStore.js';

export const REQUIRED_JOB_STORE_METHODS = Object.freeze([
  'create', 'get', 'list', 'update', 'updateAtomically', 'transition',
  'appendConversation', 'appendConversationAtomically', 'appendAudit', 'appendLog', 'appendCommand',
  'transitionWorkItem', 'claimFileOwnership', 'releaseFileOwnership',
  'acquireComponentLocks', 'renewComponentLocks', 'releaseComponentLocks',
  'assertComponentLocksOwned', 'updateWithComponentLocks',
  'invalidateForOrgChange', 'invalidateForPlanChange',
  'createDispatch', 'claimDispatch', 'claimNextDispatch', 'markDispatchDelivered', 'markDispatchRetryable',
  'listClaimableDispatches', 'savePlanWithCompareAndSet', 'approveImplementationAtomically', 'hydrateJob'
]);

export function assertJobStoreContract(store) {
  const missing = REQUIRED_JOB_STORE_METHODS.filter((method) => typeof store?.[method] !== 'function');
  if (missing.length) throw Object.assign(new Error(`Configured JobStore is missing required methods: ${missing.join(', ')}.`), { code: 'JOB_STORE_CONTRACT_INVALID' });
  return store;
}

const jobStoreScope = new AsyncLocalStorage();
let defaultJobStore = null;

export function createMemoryJobStore() {
  const componentLocks = new Map();
  const store = {
    create: createJobRecord,
    createJob: createJobRecord,
    get: getJobRecord,
    getJob: getJobRecord,
    list: listJobRecords,
    listJobs: listJobRecords,
    update: updateJob,
    updateJob,
    updateAtomically: updateJobAtomically,
    transition: transitionJob,
    transitionJob,
    appendConversation,
    appendConversationAtomically: atomicMemoryMutation,
    appendAudit,
    appendLog,
    appendCommand,
    transitionWorkItem,
    claimFileOwnership,
    releaseFileOwnership,
    acquireComponentLocks: async ({ jobId, componentKeys, leaseMilliseconds, lockToken }) => {
      const now = Date.now();
      if (componentKeys.some((key) => componentLocks.has(key) && componentLocks.get(key).jobId !== jobId && componentLocks.get(key).leaseExpiresAt > now)) {
        throw Object.assign(new Error('One or more approved components are currently locked.'), { code: 'COMPONENT_LOCKED', statusCode: 409 });
      }
      const leaseExpiresAt = now + leaseMilliseconds;
      for (const key of componentKeys) componentLocks.set(key, { jobId, lockToken, leaseExpiresAt });
      return { jobId, componentKeys, lockToken, leaseExpiresAt: new Date(leaseExpiresAt).toISOString() };
    },
    renewComponentLocks: async ({ jobId, componentKeys, leaseMilliseconds, lockToken }) => {
      const now = Date.now();
      if (componentKeys.some((key) => componentLocks.get(key)?.jobId !== jobId || componentLocks.get(key)?.lockToken !== lockToken || componentLocks.get(key).leaseExpiresAt <= now)) {
        throw Object.assign(new Error('Component lock ownership was lost.'), { code: 'COMPONENT_LOCK_LOST', statusCode: 409 });
      }
      const leaseExpiresAt = now + leaseMilliseconds;
      for (const key of componentKeys) componentLocks.set(key, { jobId, lockToken, leaseExpiresAt });
      return { jobId, componentKeys, lockToken, leaseExpiresAt: new Date(leaseExpiresAt).toISOString() };
    },
    releaseComponentLocks: async ({ jobId, componentKeys, lockToken }) => {
      for (const key of componentKeys) if (componentLocks.get(key)?.jobId === jobId && componentLocks.get(key)?.lockToken === lockToken) componentLocks.delete(key);
      return { jobId, componentKeys };
    },
    assertComponentLocksOwned: async ({ jobId, componentKeys, lockToken }) => assertMemoryLocks(componentLocks, { jobId, componentKeys, lockToken }),
    updateWithComponentLocks: async ({ jobId, componentKeys, lockToken }, operation) => {
      assertMemoryLocks(componentLocks, { jobId, componentKeys, lockToken });
      return updateJobAtomically(jobId, operation);
    },
    invalidateForOrgChange,
    invalidateForPlanChange,
    createDispatch: async (dispatch) => updateJobAtomically(dispatch.jobId, (record) => { if (!(record.dispatches || []).some((item) => item.dispatchKey === dispatch.dispatchKey)) record.dispatches.push(dispatch); return dispatch; }),
    claimNextDispatch: async () => null,
    savePlanWithCompareAndSet: async (jobId, expectedRevision, patch) => updateJobAtomically(jobId, (record) => {
      if (Number(record.revision) !== Number(expectedRevision)) throw Object.assign(new Error('Job revision is stale.'), { statusCode: 409, code: 'STALE_REVISION' });
      Object.assign(record, patch);
      return record;
    }),
    approveImplementationAtomically: atomicMemoryMutation,
    claimDispatch: claimPendingDispatch,
    markDispatchDelivered: markDispatchDispatched,
    markDispatchRetryable: markDispatchPending,
    listClaimableDispatches: listPendingDispatches,
    hydrateJob: getJobRecord
  };
  return assertJobStoreContract(store);
}

async function atomicMemoryMutation(jobId, expectedRevision, operation) {
  return updateJobAtomically(jobId, async (record) => {
    if (Number(record.revision) !== Number(expectedRevision)) throw Object.assign(new Error('Job revision is stale.'), { statusCode: 409, code: 'STALE_REVISION' });
    const outcome = await operation(record);
    if (!outcome?.result || !outcome?.dispatch) throw Object.assign(new Error('Atomic mutation must provide one durable dispatch.'), { code: 'ATOMIC_MUTATION_INVALID' });
    if ((record.dispatches || []).some((item) => item.dispatchKey === outcome.dispatch.dispatchKey)) throw Object.assign(new Error('Atomic dispatch conflicts with existing work.'), { statusCode: 409, code: 'DISPATCH_CONFLICT' });
    record.dispatches.push(outcome.dispatch);
    return outcome.result;
  });
}

function assertMemoryLocks(componentLocks, { jobId, componentKeys, lockToken }) {
  const now = Date.now();
  if (componentKeys.some((key) => componentLocks.get(key)?.jobId !== jobId || componentLocks.get(key)?.lockToken !== lockToken || componentLocks.get(key)?.leaseExpiresAt <= now)) {
    throw Object.assign(new Error('Component lock ownership was lost.'), { code: 'COMPONENT_LOCK_LOST', statusCode: 409 });
  }
  return { jobId, componentKeys, lockToken };
}

export function createPostgresJobStore({ pool, dispatchLeaseMs, claimantId, dispatchRetryBaseMs, dispatchMaxAttempts } = {}) {
  const recordStore = createPostgresJobRecordStore({ pool, dispatchLeaseMs, claimantId, dispatchRetryBaseMs, dispatchMaxAttempts });
  return assertJobStoreContract({
    ...recordStore,
    createJob: recordStore.create,
    getJob: recordStore.get,
    listJobs: recordStore.list,
    updateJob: recordStore.update,
    transitionJob: recordStore.transition,
    hydrateJob: recordStore.get
  });
}

export function setDefaultJobStore(store) {
  defaultJobStore = assertJobStoreContract(store);
}

export function currentJobStore() {
  const store = jobStoreScope.getStore() || defaultJobStore;
  if (!store && process.env.NODE_ENV === 'test') {
    defaultJobStore = createMemoryJobStore();
    return defaultJobStore;
  }
  if (!store) throw new Error('JobStore has not been configured.');
  return store;
}

export async function withJobStore(store, work) {
  return jobStoreScope.run(store, work);
}
