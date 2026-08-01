import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestPostgresPool, resetPostgresSchema } from './helpers/postgres.js';

test('requires an explicit TEST_DATABASE_URL before creating a test pool', () => {
  const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    assert.throws(
      () => createTestPostgresPool(),
      /TEST_DATABASE_URL must be set to a dedicated PostgreSQL test database/
    );
  } finally {
    restoreEnv(originalTestDatabaseUrl, originalDatabaseUrl);
  }
});

test('rejects application DATABASE_URL before creating a test pool', () => {
  const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://providus:providus@127.0.0.1:5432/providus_nexus';

  try {
    assert.throws(
      () => createTestPostgresPool(),
      /TEST_DATABASE_URL must be set to a dedicated PostgreSQL test database/
    );
  } finally {
    restoreEnv(originalTestDatabaseUrl, originalDatabaseUrl);
  }
});

test('rejects non-test database URLs before destructive cleanup queries', async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      throw new Error('query should not execute');
    }
  };

  await assert.rejects(
    resetPostgresSchema(pool, 'postgres://providus:providus@127.0.0.1:5432/providus_nexus'),
    /TEST_DATABASE_URL database name must end with _test/
  );
  assert.deepEqual(queries, []);
});

function restoreEnv(testDatabaseUrl, databaseUrl) {
  if (testDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = testDatabaseUrl;

  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
}
