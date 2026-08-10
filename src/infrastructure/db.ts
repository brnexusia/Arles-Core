import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

export const db = new Pool({
  connectionString: env.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000
});

export async function checkDb(): Promise<void> {
  await db.query('select 1');
}
