import pg from 'pg';

const { Pool } = pg;

const defaultDatabaseUrl = 'postgres://providus:providus@127.0.0.1:5432/providus_nexus';

export function createTestPostgresPool() {
  return new Pool({
    connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || defaultDatabaseUrl
  });
}

export async function resetPostgresSchema(pool) {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
}

export async function postgresIsAvailable(pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
