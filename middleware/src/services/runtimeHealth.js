import { config } from '../config.js';

export async function runtimeReadiness(options = {}) {
  const effective = { ...config, ...options };
  const checks = {
    api: { ok: true, message: 'API process is running.' },
    queue: { ok: Boolean(effective.queueDriver), message: `Queue driver: ${effective.queueDriver || 'not configured'}.` }
  };

  if (effective.jiraEnabled) {
    checks.jira = jiraReadiness(effective);
  }

  return {
    ready: Object.values(checks).every((check) => check.ok),
    checks
  };
}

function jiraReadiness(effective) {
  const configured = Boolean(effective.jiraBaseUrl && effective.jiraEmail && effective.jiraApiToken);
  return {
    ok: configured,
    message: configured
      ? 'Jira is enabled and configured.'
      : 'Jira is enabled but its connection settings are incomplete.'
  };
}
