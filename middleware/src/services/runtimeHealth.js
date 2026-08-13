import { config } from '../config.js';
import { redisConnection } from '../queue/connection.js';
import { dispatcherReadiness } from '../queue/outboxDispatcher.js';

export async function runtimeReadiness(options = {}) {
  const effective = { ...config, ...options };
  const checks = {
    api: { ok: true, message: 'API process is running.' },
    postgres: await postgresReadiness(effective.pool),
    queue: await queueReadiness(effective),
    dispatcher: dispatcherReadiness(effective.dispatcher)
  };

  if (effective.jiraEnabled) {
    checks.jira = jiraReadiness(effective);
  }

  return {
    ready: Object.values(checks).every((check) => check.ok),
    checks
  };
}

async function postgresReadiness(pool) {
  if (!pool) return { ok: false, message: 'PostgreSQL pool is not configured.' };
  try {
    await pool.query('SELECT 1');
    const migration = await pool.query("SELECT to_regclass('public.schema_migrations') AS migrations, to_regclass('public.job_dispatches') AS dispatches");
    const ready = migration.rows[0]?.migrations === 'schema_migrations' && migration.rows[0]?.dispatches === 'job_dispatches';
    return { ok: ready, message: ready ? 'PostgreSQL schema is ready.' : 'PostgreSQL schema is missing expected migrations.' };
  } catch (error) {
    return { ok: false, message: `PostgreSQL readiness failed: ${error.message}` };
  }
}

async function queueReadiness(effective) {
  if (effective.queueDriver === 'memory') return { ok: true, message: 'Memory queue driver selected explicitly.' };
  if (effective.queueDriver !== 'redis') return { ok: false, message: `Unsupported queue driver: ${effective.queueDriver || 'not configured'}.` };
  try {
    await redisConnection.ping();
    return { ok: true, message: 'Redis/BullMQ connection is ready.' };
  } catch (error) {
    return { ok: false, message: `Redis/BullMQ readiness failed: ${error.message}` };
  }
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
