import pg from 'pg';
import { URL } from 'node:url';

const { Pool } = pg;

const providusTablesInDeleteOrder = [
  'component_locks',
  'job_dispatches',
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

  expectedTestDatabaseName(databaseUrl);
  return databaseUrl;
}

export function expectedTestDatabaseName(databaseUrl = process.env.TEST_DATABASE_URL) {
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

  return databaseName;
}

export function createTestPostgresPool() {
  const databaseUrl = requireTestDatabaseUrl();
  const pool = new Pool({
    connectionString: databaseUrl
  });
  pool.expectedTestDatabaseName = expectedTestDatabaseName(databaseUrl);
  return pool;
}

export async function resetPostgresSchema(pool) {
  await verifyTestDatabaseIdentity(pool);
  const existingTables = [];
  for (const table of providusTablesInDeleteOrder) {
    const result = await pool.query('SELECT to_regclass($1) AS table_name', [`public.${table}`]);
    if (result.rows[0]?.table_name) existingTables.push(table);
  }
  if (existingTables.length) {
    await pool.query(`TRUNCATE TABLE ${existingTables.join(', ')} RESTART IDENTITY CASCADE`);
  }
}

export async function verifyTestDatabaseIdentity(pool) {
  const expectedDatabaseName = pool.expectedTestDatabaseName || expectedTestDatabaseName();
  let result;
  try {
    result = await pool.query('SELECT current_database() AS database_name');
  } catch (error) {
    throw new Error(
      `Required PostgreSQL integration test database "${expectedDatabaseName}" is unavailable. ` +
      'Start PostgreSQL/Docker and ensure TEST_DATABASE_URL points to the dedicated test database. ' +
      `The PostgreSQL integration test was not executed. Cause: ${error.message}`
    );
  }

  const actualDatabaseName = result.rows[0]?.database_name;
  if (actualDatabaseName !== expectedDatabaseName) {
    throw new Error(
      `Refusing to reset PostgreSQL test database: TEST_DATABASE_URL expects "${expectedDatabaseName}" ` +
      `but the pool is connected to "${actualDatabaseName}".`
    );
  }
}
