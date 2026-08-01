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

test('accepts cleanup only when the pool is connected to the expected test database', async () => {
  const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = 'postgres://providus:providus@127.0.0.1:5432/providus_nexus_test';
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(normalizeSql(sql));
      if (sql === 'SELECT current_database() AS database_name') {
        return { rows: [{ database_name: 'providus_nexus_test' }] };
      }
      return { rows: [] };
    }
  };

  try {
    await resetPostgresSchema(pool);
    assert.equal(queries[0], 'SELECT current_database() AS database_name');
    assert.ok(queries.some((query) => query.includes('DELETE FROM component_locks')));
  } finally {
    if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
  }
});

test('rejects non-test database URLs before cleanup queries', async () => {
  const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = 'postgres://providus:providus@127.0.0.1:5432/providus_nexus';
  const queries = [];
  const pool = recordQueriesPool(queries, 'providus_nexus');

  try {
    await assert.rejects(
      resetPostgresSchema(pool),
      /TEST_DATABASE_URL database name must end with _test/
    );
    assert.deepEqual(queries, []);
  } finally {
    if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
  }
});

test('rejects missing test database URL before cleanup queries', async () => {
  const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
  const queries = [];
  const pool = recordQueriesPool(queries, 'providus_nexus_test');

  try {
    await assert.rejects(
      resetPostgresSchema(pool),
      /TEST_DATABASE_URL must be set to a dedicated PostgreSQL test database/
    );
    assert.deepEqual(queries, []);
  } finally {
    if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
  }
});

test('rejects cleanup when actual database does not match TEST_DATABASE_URL', async () => {
  const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = 'postgres://providus:providus@127.0.0.1:5432/providus_nexus_test';
  const queries = [];
  const pool = recordQueriesPool(queries, 'providus_other_test');

  try {
    await assert.rejects(
      resetPostgresSchema(pool),
      /Refusing to reset PostgreSQL test database/
    );
    assert.deepEqual(queries, ['SELECT current_database() AS database_name']);
  } finally {
    if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
  }
});

function restoreEnv(testDatabaseUrl, databaseUrl) {
  if (testDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = testDatabaseUrl;

  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
}

function recordQueriesPool(queries, databaseName) {
  return {
    async query(sql) {
      queries.push(normalizeSql(sql));
      if (sql === 'SELECT current_database() AS database_name') {
        return { rows: [{ database_name: databaseName }] };
      }
      throw new Error('cleanup query should not execute');
    }
  };
}

function normalizeSql(sql) {
  return sql.trim().replace(/\s+/g, ' ');
}
