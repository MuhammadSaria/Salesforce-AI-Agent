import { canonicalMetadataPath } from '../domain/metadataPath.js';
import { currentJobStore } from '../persistence/jobStore.js';
import { nanoid } from 'nanoid';

export function acquireComponentLocks(request, options = {}) {
  return createComponentLockService({ jobStore: options.jobStore || currentJobStore() }).acquireComponentLocks(request);
}

export function renewComponentLocks(request, options = {}) {
  return createComponentLockService({ jobStore: options.jobStore || currentJobStore() }).renewComponentLocks(request);
}

export function releaseComponentLocks(request, options = {}) {
  return createComponentLockService({ jobStore: options.jobStore || currentJobStore() }).releaseComponentLocks(request);
}

export function createComponentLockService({ jobStore } = {}) {
  if (!jobStore) throw lockError('COMPONENT_LOCK_STORE_REQUIRED', 'A component lock store is required.');
  return {
    acquireComponentLocks: (request) => jobStore.acquireComponentLocks({ ...normalizeRequest(request), lockToken: nanoid() }),
    renewComponentLocks: (request) => jobStore.renewComponentLocks(normalizeRequest(request)),
    releaseComponentLocks: (request) => jobStore.releaseComponentLocks(normalizeRequest(request, { leaseRequired: false })),
    assertComponentLocksOwned: (request) => jobStore.assertComponentLocksOwned(normalizeRequest(request, { leaseRequired: false })),
    updateWithComponentLocks: (request, operation) => jobStore.updateWithComponentLocks(normalizeRequest(request, { leaseRequired: false }), operation)
  };
}

export function componentKeysForPlan(plan) {
  const components = Array.isArray(plan?.components) ? plan.components : [];
  if (!components.length) throw invalidRequest();
  return normalizeComponentKeys(components.map((component) => `${component.metadataType}:${component.apiName}`));
}

export function startComponentLockHeartbeat({ locks, jobId, componentKeys, lockToken, leaseSeconds, intervalMs, onLeaseLost, scheduler = globalThis } = {}) {
  const leaseMs = Number(leaseSeconds) * 1000;
  const requestedMs = Number(intervalMs) > 0 ? Number(intervalMs) : Math.floor(leaseMs / 3);
  const heartbeatMs = Math.max(10, Math.min(requestedMs, Math.floor(leaseMs / 2)));
  let stopped = false;
  let running = false;
  const timer = scheduler.setInterval(async () => {
    if (stopped || running) return;
    running = true;
    try {
      await locks.renewComponentLocks({ jobId, componentKeys, lockToken, leaseSeconds });
    } catch (error) {
      stopped = true;
      scheduler.clearInterval(timer);
      await onLeaseLost?.(error);
    } finally {
      running = false;
    }
  }, heartbeatMs);
  return { stop() { stopped = true; scheduler.clearInterval(timer); } };
}

export async function withComponentLocks({ locks, jobId, componentKeys, leaseSeconds, heartbeatIntervalMs, scheduler }, work) {
  const acquisition = await locks.acquireComponentLocks({ jobId, componentKeys, leaseSeconds });
  const lockToken = acquisition.lockToken;
  let leaseFailure = null;
  const heartbeat = startComponentLockHeartbeat({
    locks, jobId, componentKeys, lockToken, leaseSeconds, intervalMs: heartbeatIntervalMs, scheduler,
    onLeaseLost: (error) => { leaseFailure = error; }
  });
  const assertLeaseOwned = async () => {
    if (leaseFailure) throw lockError('COMPONENT_LOCK_LOST', 'Component lock ownership was lost.');
    await locks.assertComponentLocksOwned({ jobId, componentKeys, lockToken });
  };
  let workError = null;
  try {
    return await work({ assertLeaseOwned, lockToken });
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    heartbeat.stop();
    try {
      await locks.releaseComponentLocks({ jobId, componentKeys, lockToken });
    } catch (releaseError) {
      if (!workError) throw releaseError;
    }
  }
}

function normalizeRequest(request, { leaseRequired = true } = {}) {
  const jobId = String(request?.jobId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw invalidRequest();
  const componentKeys = normalizeComponentKeys(request?.componentKeys);
  const lockToken = String(request?.lockToken || '');
  if (!leaseRequired) {
    if (!/^[A-Za-z0-9_-]{10,128}$/.test(lockToken)) throw invalidRequest();
    return { jobId, componentKeys, lockToken };
  }
  const leaseSeconds = Number(request?.leaseSeconds);
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > 3600) throw invalidRequest();
  if (lockToken && !/^[A-Za-z0-9_-]{10,128}$/.test(lockToken)) throw invalidRequest();
  return { jobId, componentKeys, ...(lockToken ? { lockToken } : {}), leaseMilliseconds: Math.ceil(leaseSeconds * 1000) };
}

function normalizeComponentKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 100) throw invalidRequest();
  const normalized = [...new Set(keys.map((key) => {
    const raw = String(key || '');
    const separator = raw.indexOf(':');
    if (separator <= 0 || separator !== raw.lastIndexOf(':')) throw invalidRequest();
    const metadataType = raw.slice(0, separator);
    const apiName = raw.slice(separator + 1);
    try { canonicalMetadataPath(metadataType, apiName); } catch { throw invalidRequest(); }
    const canonical = `${metadataType}:${apiName}`;
    if (raw !== canonical) throw invalidRequest();
    return canonical;
  }))].sort();
  return normalized;
}

function invalidRequest() {
  return lockError('INVALID_COMPONENT_LOCK_REQUEST', 'Component lock request is invalid.');
}

function lockError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
