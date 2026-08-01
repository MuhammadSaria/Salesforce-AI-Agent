import { databasePool } from './database.js';
import { migrate } from './migrate.js';

const pool = databasePool();

try {
  await migrate(pool);
} finally {
  await pool.end();
}
