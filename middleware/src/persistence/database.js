import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export function databasePool() {
  return new Pool({
    connectionString: config.databaseUrl
  });
}
