import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../infrastructure/db.js';

type AppliedMigration = {
  filename: string;
  checksum: string;
};

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function ensureMigrationTable(): Promise<void> {
  await db.query(`
    create table if not exists schema_migrations (
      id bigserial primary key,
      filename text not null unique,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function migrate(): Promise<void> {
  const migrationsDir = join(process.cwd(), 'migrations');

  await ensureMigrationTable();

  const files = (await readdir(migrationsDir))
    .filter((name: string) => /^\d+_.+\.sql$/i.test(name))
    .sort((a: string, b: string) => a.localeCompare(b));

  const appliedResult = await db.query<AppliedMigration>(
    'select filename, checksum from schema_migrations order by filename'
  );

  const applied = new Map<string, string>(
    appliedResult.rows.map((row: AppliedMigration) => [
      row.filename,
      row.checksum
    ])
  );

  console.log(`[Migrations] ${files.length} arquivo(s) encontrado(s).`);

  for (const filename of files) {
    const sql = await readFile(join(migrationsDir, filename), 'utf8');
    const currentChecksum = checksum(sql);
    const existingChecksum = applied.get(filename);

    if (existingChecksum) {
      if (existingChecksum !== currentChecksum) {
        throw new Error(
          `Migration já aplicada foi alterada: ${filename}. ` +
          'Crie uma nova migration em vez de editar uma antiga.'
        );
      }

      console.log(`[Migrations] ${filename} já aplicada.`);
      continue;
    }

    const client = await db.connect();

    try {
      console.log(`[Migrations] Aplicando ${filename}...`);

      await client.query('begin');
      await client.query(sql);
      await client.query(
        `
        insert into schema_migrations (filename, checksum)
        values ($1, $2)
        `,
        [filename, currentChecksum]
      );
      await client.query('commit');

      console.log(`[Migrations] ${filename} aplicada com sucesso.`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  console.log('[Migrations] Banco atualizado.');
}

try {
  await migrate();
  await db.end();
} catch (error) {
  console.error('[Migrations] Falha:', error);
  await db.end().catch(() => undefined);
  process.exit(1);
}
