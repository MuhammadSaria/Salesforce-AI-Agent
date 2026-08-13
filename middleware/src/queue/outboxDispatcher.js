import { config } from '../config.js';
import { logger } from '../logger.js';
import { enqueueAgentJob } from './agentQueue.js';

const activeDispatchers = new WeakMap();

export function startOutboxDispatcher({ jobStore, enqueue = enqueueAgentJob, intervalMs = Number(process.env.DISPATCHER_POLL_INTERVAL_MS || 5000), maxPerScan = Number(process.env.DISPATCHER_MAX_PER_SCAN || 25) } = {}) {
  if (!jobStore) throw new Error('JobStore is required for outbox dispatcher startup.');
  if (activeDispatchers.has(jobStore)) return activeDispatchers.get(jobStore);

  let stopped = false;
  let timer = null;
  let running = false;

  async function scan() {
    if (stopped || running) return;
    running = true;
    try {
      for (let index = 0; index < maxPerScan; index += 1) {
        const dispatch = await jobStore.claimNextDispatch?.();
        if (!dispatch) break;
        try {
          await enqueue({ jobId: dispatch.jobId, action: dispatch.action, actor: dispatch.actor || dispatch.actorId }, { jobId: dispatch.dispatchKey });
          await jobStore.markDispatchDelivered(dispatch.dispatchKey);
        } catch (error) {
          await jobStore.markDispatchRetryable(dispatch.dispatchKey, error);
        }
      }
    } catch (error) {
      logger.warn({ err: error }, 'Outbox dispatcher scan failed');
    } finally {
      running = false;
    }
  }

  const boundedIntervalMs = Math.max(250, Math.min(60000, intervalMs));
  const dispatcher = {
    get running() { return !stopped; },
    scan,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      activeDispatchers.delete(jobStore);
    }
  };

  timer = setInterval(scan, boundedIntervalMs);
  timer.unref?.();
  globalThis.queueMicrotask(() => scan());
  activeDispatchers.set(jobStore, dispatcher);
  return dispatcher;
}

export function dispatcherReadiness(dispatcher) {
  if (config.queueDriver === 'memory') return { ok: true, message: 'Memory dispatcher mode is explicit.' };
  return {
    ok: Boolean(dispatcher?.running),
    message: dispatcher?.running ? 'Outbox dispatcher is running.' : 'Outbox dispatcher is not running.'
  };
}
