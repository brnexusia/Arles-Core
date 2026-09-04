import { createHash } from 'node:crypto';
import { db } from '../infrastructure/db.js';

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function idleHours(): number {
  const value = Number(process.env.AUTH_SESSION_IDLE_HOURS || 168);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 168;
}

function maxActiveSessions(): number {
  const value = Number(process.env.AUTH_SESSION_MAX_ACTIVE || 5);
  return Number.isFinite(value) && value >= 1 ? Math.min(20, Math.floor(value)) : 5;
}

export async function persistedSessionUserId(token: string): Promise<string | null> {
  if (!token) return null;
  const hash = tokenHash(token);
  const result = await db.query<{ user_id: string }>(
    `select user_id::text
       from auth_sessions
      where token_hash=$1
        and expires_at > now()
        and last_seen_at > now() - ($2::text || ' hours')::interval
      limit 1`,
    [hash, idleHours()]
  );
  const row = result.rows[0];
  if (!row) return null;

  // Avoid a write on every request while keeping idle expiry accurate enough.
  await db.query(
    `update auth_sessions
        set last_seen_at=now()
      where token_hash=$1
        and last_seen_at < now() - interval '5 minutes'`,
    [hash]
  ).catch(() => undefined);

  return row.user_id;
}

export async function trimUserSessions(userId: string, keepToken: string): Promise<void> {
  const keepHash = tokenHash(keepToken);
  const max = maxActiveSessions();
  await db.query(`delete from auth_sessions where user_id=$1 and expires_at <= now()`, [userId]);
  await db.query(
    `delete from auth_sessions
      where id in (
        select id from auth_sessions
         where user_id=$1 and token_hash<>$2
         order by created_at desc
         offset $3
      )`,
    [userId, keepHash, Math.max(0, max - 1)]
  );
}
