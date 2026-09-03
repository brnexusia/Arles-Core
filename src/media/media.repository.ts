import { db } from '../infrastructure/db.js';

const MAX_SERVED_MEDIA_BYTES = 20 * 1024 * 1024;

export async function getMediaByToken(
  token: string
): Promise<{ mimeType: string; data: Buffer } | null> {
  const result = await db.query<{ mime_type: string; data: Buffer }>(
    `select mime_type, data
     from media_files
     where public_token = $1
       and octet_length(data) <= $2
     limit 1`,
    [token, MAX_SERVED_MEDIA_BYTES]
  );
  const row = result.rows[0];
  return row ? { mimeType: row.mime_type, data: row.data } : null;
}
