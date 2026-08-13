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

const jobStoreScope = new AsyncLocalStorage();
let defaultJobStore = null;

export function createMemoryJobStore() {
  return {
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
    appendConversationAtomically: appendConversation,
    appendAudit,
    appendLog,
    appendCommand,
    transitionWorkItem,
    claimFileOwnership,
    releaseFileOwnership,
    invalidateForOrgChange,
    invalidateForPlanChange,
    claimDispatch: claimPendingDispatch,
    markDispatchDelivered: markDispatchDispatched,
    markDispatchRetryable: markDispatchPending,
    listClaimableDispatches: listPendingDispatches,
    hydrateJob: getJobRecord
  };
}

export function createPostgresJobStore({ pool, dispatchLeaseMs, claimantId } = {}) {
  const recordStore = createPostgresJobRecordStore({ pool, dispatchLeaseMs, claimantId });
  return {
    ...recordStore,
    createJob: recordStore.create,
    getJob: recordStore.get,
    listJobs: recordStore.list,
    updateJob: recordStore.update,
    transitionJob: recordStore.transition,
    hydrateJob: recordStore.get
  };
}

export function setDefaultJobStore(store) {
  defaultJobStore = store;
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
