import { db } from '../infrastructure/db.js';

export async function getMediaByToken(
  token: string
): Promise<{ mimeType: string; data: Buffer } | null> {
  const result = await db.query<{ mime_type: string; data: Buffer }>(
    `select mime_type, data from media_files where public_token = $1 limit 1`,
    [token]
  );
  const row = result.rows[0];
  return row ? { mimeType: row.mime_type, data: row.data } : null;
}
