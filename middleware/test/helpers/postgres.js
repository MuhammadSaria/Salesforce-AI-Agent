import pg from 'pg';
import { URL } from 'node:url';

const { Pool } = pg;

const providusTablesInDeleteOrder = [
  'component_locks',
  'job_events',
  'job_approvals',
  'job_plans',
  'job_messages',
  'development_jobs',
  'schema_migrations'
];

export function requireTestDatabaseUrl(databaseUrl = process.env.TEST_DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error('TEST_DATABASE_URL must be set to a dedicated PostgreSQL test database.');
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }

  const databaseName = parsed.pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL database name must end with _test.');
  }

  return databaseUrl;
}

export function createTestPostgresPool() {
  return new Pool({
    connectionString: requireTestDatabaseUrl()
  });
}

export async function resetPostgresSchema(pool, databaseUrl = process.env.TEST_DATABASE_URL) {
  requireTestDatabaseUrl(databaseUrl);
  for (const table of providusTablesInDeleteOrder) {
    await pool.query(`
      DO $$
      BEGIN
        IF to_regclass('public.${table}') IS NOT NULL THEN
          DELETE FROM ${table};
        END IF;
      END $$;
    `);
  }
}

export async function postgresIsAvailable(pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
