import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

// PostgreSQL DATE não tem hora nem fuso. Manter como YYYY-MM-DD evita que o driver
// transforme a data em Date/GMT e contamine respostas do Cash com hora/localização.
pg.types.setTypeParser(1082, value => value);

export const db = new Pool({
  connectionString: env.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000
});

export async function checkDb(): Promise<void> {
  await db.query('select 1');
}
