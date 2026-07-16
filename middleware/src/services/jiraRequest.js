import { config } from '../config.js';

export async function runJiraRequest(operation, options = {}) {
  const timeoutMs = Math.max(10, Number(options.timeoutMs ?? config.jiraRequestTimeoutMs ?? 15000));
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Jira request timed out after ${timeoutMs} ms.`)), timeoutMs);
  timer.unref?.();

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Jira request timed out after ${timeoutMs} ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
