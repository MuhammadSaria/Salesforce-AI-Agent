import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeReadiness } from '../src/services/runtimeHealth.js';

test('Phase 1 readiness does not require Jira', async () => {
  const readiness = await runtimeReadiness({ jiraEnabled: false, queueDriver: 'memory', pool: readyPool(), dispatcher: { running: true } });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.checks.jira, undefined);
});

test('readiness includes Jira checks only when Jira is enabled', async () => {
  const readiness = await runtimeReadiness({
    jiraEnabled: true,
    queueDriver: 'memory',
    pool: readyPool(),
    dispatcher: { running: true },
    jiraBaseUrl: '',
    jiraEmail: '',
    jiraApiToken: ''
  });

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.checks.jira, {
    ok: false,
    message: 'Jira is enabled but its connection settings are incomplete.'
  });
});

test('readiness fails closed without PostgreSQL', async () => {
  const readiness = await runtimeReadiness({ jiraEnabled: false, queueDriver: 'memory', dispatcher: { running: true } });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.checks.postgres.ok, false);
});

function readyPool() {
  return {
    async query(sql) {
      if (String(sql).includes('to_regclass')) {
        return { rows: [{ migrations: 'schema_migrations', dispatches: 'job_dispatches' }] };
      }
      return { rows: [{ '?column?': 1 }] };
    }
  };
}
