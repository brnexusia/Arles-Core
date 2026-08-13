import bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { db } from '../infrastructure/db.js';
import { redis } from '../infrastructure/redis.js';
import { env } from '../config/env.js';

export type AuthUserView = {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  companyId: string;
  company: string;
  verticals: string[];
  capabilities: string[];
  has_calendar: boolean;
  has_services: boolean;
  has_custom_metrics: boolean;
};

export type AuthResult = {
  sessionToken: string;
  user: AuthUserView;
};

function emailNorm(value: string): string {
  return value.trim().toLowerCase();
}

function phoneNorm(value: string | null | undefined): string {
  return String(value ?? '').replace(/\D/g, '');
}

function deterministicInstance(companyId: string): string {
  return `arles-${companyId.replace(/-/g, '').slice(0, 24)}`;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type SignedSessionPayload = {
  v: 1;
  uid: string;
  exp: number;
  nonce: string;
};

function sessionSecret(): string {
  const secret = env.authSessionSecret || env.internalApiKey;
  if (!secret) throw new Error('AUTH_SESSION_SECRET_MISSING');
  return secret;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signSessionPayload(encodedPayload: string): string {
  return createHmac('sha256', sessionSecret())
    .update(encodedPayload, 'utf8')
    .digest('base64url');
}

function createSignedSessionToken(userId: string, expiresAt: Date): string {
  const payload: SignedSessionPayload = {
    v: 1,
    uid: userId,
    exp: Math.floor(expiresAt.getTime() / 1000),
    nonce: randomBytes(16).toString('base64url')
  };

  const encoded = base64urlJson(payload);
  return `${encoded}.${signSessionPayload(encoded)}`;
}

function parseSignedSessionToken(token: string): SignedSessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const expected = signSessionPayload(encoded);

  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as Partial<SignedSessionPayload>;

    if (
      parsed.v !== 1 ||
      typeof parsed.uid !== 'string' ||
      !parsed.uid ||
      typeof parsed.exp !== 'number' ||
      !Number.isFinite(parsed.exp) ||
      typeof parsed.nonce !== 'string'
    ) {
      return null;
    }

    return parsed as SignedSessionPayload;
  } catch {
    return null;
  }
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


export class AuthService {
  private async createSession(userId: string): Promise<string> {
    const expiresAt = new Date(
      Date.now() + env.authSessionDays * 24 * 60 * 60 * 1000
    );

    // Sessão assinada: a validação não depende de uma segunda leitura
    // imediata do PostgreSQL. Isso elimina o problema em que login criava
    // a sessão, mas /internal/auth/session não conseguia encontrá-la.
    const token = createSignedSessionToken(userId, expiresAt);

    // Mantemos registro no banco para auditoria e limpeza, mas ele não é
    // mais a fonte de verdade da validade criptográfica da sessão.
    await db.query(
      `insert into auth_sessions(user_id, token_hash, expires_at)
       values($1,$2,$3)`,
      [userId, tokenHash(token), expiresAt]
    );

    return token;
  }

  private async userView(userId: string): Promise<AuthUserView | null> {
    const result = await db.query<{
      id: string;
      email: string;
      name: string;
      role: 'admin' | 'user';
      company_id: string | null;
      company_name: string | null;
      verticals: string[] | null;
      capabilities: string[] | null;
    }>(
      `select
         u.id::text,
         u.email,
         u.name,
         u.role,
         u.company_id::text,
         c.name as company_name,
         coalesce((
           select array_agg(cv.vertical_id order by cv.vertical_id)
           from company_verticals cv
           where cv.company_id = u.company_id and cv.enabled = true
         ), array[]::text[]) as verticals,
         coalesce((
           select array_agg(distinct capability order by capability)
           from company_verticals cv
           join vertical_definitions vd on vd.id = cv.vertical_id
           cross join lateral unnest(vd.capabilities) capability
           where cv.company_id = u.company_id and cv.enabled = true
         ), array[]::text[]) as capabilities
       from auth_users u
       left join companies c on c.id = u.company_id
       where u.id = $1
       limit 1`,
      [userId]
    );

    const row = result.rows[0];
    if (!row) return null;

    const verticals = row.verticals ?? [];
    const capabilities = row.capabilities ?? [];

    return {
      id: row.id,
      email: row.email,
      name: row.name || 'Gestor',
      role: row.role,
      companyId: row.company_id || 'admin',
      company: row.company_name || 'Admin',
      verticals,
      capabilities,
      has_calendar: false,
      has_services: false,
      has_custom_metrics: false
    };
  }

  async register(input: {
    name: string;
    companyName: string;
    email: string;
    phone: string;
    password: string;
    verticalId: string;
  }): Promise<AuthResult> {
    const email = emailNorm(input.email);
    const phone = phoneNorm(input.phone);
    const name = input.name.trim();
    const companyName = input.companyName.trim();
    const password = input.password;
    const verticalId = input.verticalId.trim().toLowerCase();

    if (!name || !companyName) throw new Error('FIELDS_REQUIRED');
    if (!validEmail(email)) throw new Error('EMAIL_INVALID');
    if (password.length < 6) throw new Error('PASSWORD_TOO_SHORT');
    if (phone.length < 10 || phone.length > 15) throw new Error('PHONE_INVALID');
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(verticalId)) throw new Error('VERTICAL_REQUIRED');

    const vertical = await db.query(
      `select 1 from vertical_definitions where id = $1 and enabled = true limit 1`,
      [verticalId]
    );
    if (!vertical.rowCount) throw new Error('VERTICAL_NOT_FOUND');

    const existing = await db.query(
      `select 1 from auth_users where email_normalized = $1 limit 1`,
      [email]
    );
    if (existing.rowCount) throw new Error('EMAIL_ALREADY_REGISTERED');

    const trialUsed = await db.query(
      `select 1
       from trial_entitlements
       where email_normalized = $1
          or ($2 <> '' and phone_normalized = $2)
       limit 1`,
      [email, phone]
    );
    if (trialUsed.rowCount) throw new Error('TRIAL_ALREADY_USED');

    const companyId = randomUUID();
    const userId = randomUUID();
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const passwordHash = await bcrypt.hash(password, 12);

    const client = await db.connect();
    try {
      await client.query('begin');

      await client.query(
        `insert into companies(
           id,name,slug,vertical,active_vertical_id,evolution_instance,
           subscription_status,access_active,trial_started_at,trial_ends_at,
           legacy_supabase_migrated,created_at,updated_at
         ) values(
           $1,$2,$3,$4,$4,$5,
           'trial',true,$6,$7,true,now(),now()
         )`,
        [
          companyId,
          companyName,
          `arles-${companyId.replace(/-/g, '').slice(0, 16)}`,
          verticalId,
          deterministicInstance(companyId),
          now,
          trialEndsAt
        ]
      );

      await client.query(
        `insert into company_verticals(company_id, vertical_id, enabled, onboarding_completed)
         values($1,$2,true,false)`,
        [companyId, verticalId]
      );

      await client.query(
        `insert into auth_users(
           id,company_id,email,email_normalized,password_hash,name,phone,role,created_at,updated_at
         ) values($1,$2,$3,$3,$4,$5,$6,'user',now(),now())`,
        [userId, companyId, email, passwordHash, name, phone]
      );

      await client.query(
        `insert into trial_entitlements(
           company_id,email_normalized,phone_normalized,trial_started_at,trial_ends_at
         ) values($1,$2,$3,$4,$5)`,
        [companyId, email, phone, now, trialEndsAt]
      );

      await client.query(
        `insert into company_settings(company_id,config)
         values($1,$2::jsonb)
         on conflict(company_id) do nothing`,
        [companyId, JSON.stringify({ email, phone, display_name: companyName })]
      );

      await client.query(
        `insert into whatsapp_connections(company_id,instance_name,status)
         values($1,$2,'disconnected')
         on conflict(company_id) do nothing`,
        [companyId, deterministicInstance(companyId)]
      );

      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    const sessionToken = await this.createSession(userId);
    const user = await this.userView(userId);
    if (!user) throw new Error('AUTH_USER_NOT_FOUND');
    return { sessionToken, user };
  }

  async login(emailInput: string, password: string): Promise<AuthResult> {
    const email = emailNorm(emailInput);
    const failKey = `arles:auth:fail:${email}`;

    const failures = Number(await redis.get(failKey) || 0);
    if (failures >= 10) throw new Error('LOGIN_RATE_LIMITED');

    const result = await db.query<{
      id: string;
      password_hash: string | null;
    }>(
      `select id::text, password_hash
       from auth_users
       where email_normalized = $1
       limit 1`,
      [email]
    );

    const row = result.rows[0];
    const ok = !!row?.password_hash &&
      await bcrypt.compare(password, row.password_hash);

    if (!ok || !row) {
      const count = await redis.incr(failKey);
      if (count === 1) await redis.expire(failKey, 15 * 60);
      throw new Error('INVALID_CREDENTIALS');
    }

    await redis.del(failKey);
    await db.query(
      `update auth_users set updated_at = now() where id = $1`,
      [row.id]
    );

    const sessionToken = await this.createSession(row.id);
    const user = await this.userView(row.id);
    if (!user) throw new Error('AUTH_USER_NOT_FOUND');
    return { sessionToken, user };
  }

  async session(token: string): Promise<AuthUserView | null> {
    if (!token) return null;

    const payload = parseSignedSessionToken(token);
    if (!payload) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp <= nowSeconds) return null;

    const hash = tokenHash(token);

    // Logout revoga a sessão no Redis imediatamente, sem depender do banco.
    const revoked = await redis.get(`arles:auth:revoked:${hash}`);
    if (revoked) return null;

    // Best-effort para auditoria. Se o registro tiver sido limpo do banco,
    // uma sessão criptograficamente válida continua funcionando.
    await db.query(
      `update auth_sessions
       set last_seen_at = now()
       where token_hash = $1`,
      [hash]
    ).catch(() => undefined);

    return this.userView(payload.uid);
  }

  async logout(token: string): Promise<void> {
    if (!token) return;

    const hash = tokenHash(token);
    const payload = parseSignedSessionToken(token);

    if (payload) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ttl = Math.max(1, payload.exp - nowSeconds);

      await redis.set(
        `arles:auth:revoked:${hash}`,
        '1',
        'EX',
        ttl
      );
    }

    await db.query(
      `delete from auth_sessions where token_hash = $1`,
      [hash]
    ).catch(() => undefined);
  }

}

export const authService = new AuthService();
