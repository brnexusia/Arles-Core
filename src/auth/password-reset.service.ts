import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../infrastructure/db.js';

function emailNorm(value: string): string {
  return value.trim().toLowerCase();
}

function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function resetBaseUrl(): string {
  return String(process.env.PASSWORD_RESET_APP_URL || process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
}

async function sendResetEmail(email: string, token: string): Promise<void> {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.PASSWORD_RESET_FROM_EMAIL || '').trim();
  const baseUrl = resetBaseUrl();
  if (!apiKey || !from || !baseUrl) return;

  const link = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': `arles-reset-${hashToken(token).slice(0, 24)}`
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Redefina sua senha do Arles',
      html: `<p>Recebemos uma solicitação para redefinir sua senha.</p><p><a href="${link}">Definir nova senha</a></p><p>Este link expira em 20 minutos e só pode ser usado uma vez.</p><p>Se você não solicitou isso, ignore este e-mail.</p>`
    }),
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    throw new Error(`PASSWORD_RESET_EMAIL_FAILED:${response.status}`);
  }
}

export class PasswordResetService {
  async request(emailInput: string): Promise<void> {
    const email = emailNorm(emailInput);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;

    const result = await db.query<{ id: string }>(
      `select id::text from auth_users where email_normalized=$1 limit 1`,
      [email]
    );
    const userId = result.rows[0]?.id;
    if (!userId) return;

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);

    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(
        `delete from auth_password_reset_tokens
          where user_id=$1 and (used_at is not null or expires_at <= now() or created_at < now() - interval '1 day')`,
        [userId]
      );
      await client.query(
        `insert into auth_password_reset_tokens(user_id,token_hash,expires_at)
         values($1,$2,$3)`,
        [userId, tokenHash, expiresAt]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    try {
      await sendResetEmail(email, token);
    } catch (error) {
      await db.query(`delete from auth_password_reset_tokens where token_hash=$1`, [tokenHash]).catch(() => undefined);
      throw error;
    }
  }

  async confirm(tokenInput: string, newPassword: string): Promise<void> {
    const token = String(tokenInput || '').trim();
    if (token.length < 32 || token.length > 200) throw new Error('PASSWORD_RESET_INVALID');
    if (newPassword.length < 10 || newPassword.length > 200) throw new Error('PASSWORD_RESET_PASSWORD_WEAK');

    const tokenHash = hashToken(token);
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const client = await db.connect();
    try {
      await client.query('begin');
      const result = await client.query<{ id: string; user_id: string }>(
        `select id::text,user_id::text
           from auth_password_reset_tokens
          where token_hash=$1 and used_at is null and expires_at > now()
          for update`,
        [tokenHash]
      );
      const row = result.rows[0];
      if (!row) throw new Error('PASSWORD_RESET_INVALID');

      await client.query(`update auth_users set password_hash=$2,updated_at=now() where id=$1`, [row.user_id, passwordHash]);
      await client.query(`update auth_password_reset_tokens set used_at=now() where id=$1`, [row.id]);
      await client.query(`delete from auth_sessions where user_id=$1`, [row.user_id]);
      await client.query(`delete from auth_password_reset_tokens where user_id=$1 and id<>$2`, [row.user_id, row.id]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const passwordResetService = new PasswordResetService();
