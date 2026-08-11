import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  has_delivery: boolean;
  has_calendar: boolean;
  has_services: boolean;
  has_custom_metrics: boolean;
};

export type AuthResult = {
  sessionToken: string;
  user: AuthUserView;
};

type LegacyCompanyInput = {
  id: string;
  name: string;
  subscription_status?: string | null;
  trial_started_at?: string | null;
  trial_ends_at?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_price_id?: string | null;
  subscription_started_at?: string | null;
  subscription_current_period_end?: string | null;
  cancel_at_period_end?: boolean | null;
  plan_key?: string | null;
  monthly_contact_limit?: number | null;
  monthly_contacts_used?: number | null;
  store_info_completed?: boolean | null;
  whatsapp_completed?: boolean | null;
  onboarding_completed?: boolean | null;
  logo_url?: string | null;
  instagram?: string | null;
};

export type LegacyAuthInput = {
  email: string;
  password: string;
  name?: string | null;
  phone?: string | null;
  legacy_user_id?: string | null;
  company: LegacyCompanyInput;
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

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function accessFrom(
  status: string,
  trialEndsAt?: string | null,
  periodEnd?: string | null
): boolean {
  const now = Date.now();
  if (status === 'active') {
    return !periodEnd || new Date(periodEnd).getTime() > now;
  }
  if (status === 'trial') {
    return !trialEndsAt || new Date(trialEndsAt).getTime() > now;
  }
  return false;
}

function planLimit(plan: string | null | undefined): number | null {
  if (plan === 'essential') return 360;
  if (plan === 'professional') return 1500;
  if (plan === 'scale') return 3000;
  return null;
}

export class AuthService {
  private async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + env.authSessionDays * 24 * 60 * 60 * 1000
    );

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
      vertical: string | null;
    }>(
      `select
         u.id::text,
         u.email,
         u.name,
         u.role,
         u.company_id::text,
         c.name as company_name,
         c.vertical
       from auth_users u
       left join companies c on c.id = u.company_id
       where u.id = $1
       limit 1`,
      [userId]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      email: row.email,
      name: row.name || 'Gestor',
      role: row.role,
      companyId: row.company_id || 'admin',
      company: row.company_name || 'Admin',
      has_delivery: row.role === 'user' ? (row.vertical || 'delivery') === 'delivery' : false,
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
  }): Promise<AuthResult> {
    const email = emailNorm(input.email);
    const phone = phoneNorm(input.phone);
    const name = input.name.trim();
    const companyName = input.companyName.trim();
    const password = input.password;

    if (!validEmail(email)) throw new Error('EMAIL_INVALID');
    if (password.length < 6) throw new Error('PASSWORD_TOO_SHORT');
    if (!name || !companyName || !phone) throw new Error('FIELDS_REQUIRED');

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
           id,name,slug,vertical,evolution_instance,
           subscription_status,access_active,trial_started_at,trial_ends_at,
           legacy_supabase_migrated,created_at,updated_at
         ) values(
           $1,$2,$3,'delivery',$4,
           'trial',true,$5,$6,true,now(),now()
         )`,
        [
          companyId,
          companyName,
          `delivery-${companyId.replace(/-/g, '').slice(0, 16)}`,
          deterministicInstance(companyId),
          now,
          trialEndsAt
        ]
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
    const hash = tokenHash(token);

    const result = await db.query<{ user_id: string }>(
      `select user_id::text
       from auth_sessions
       where token_hash = $1
         and expires_at > now()
       limit 1`,
      [hash]
    );

    const row = result.rows[0];
    if (!row) return null;

    await db.query(
      `update auth_sessions set last_seen_at = now() where token_hash = $1`,
      [hash]
    );

    return this.userView(row.user_id);
  }

  async logout(token: string): Promise<void> {
    if (!token) return;
    await db.query(
      `delete from auth_sessions where token_hash = $1`,
      [tokenHash(token)]
    );
  }

  async migrateLegacy(input: LegacyAuthInput): Promise<AuthResult> {
    const email = emailNorm(input.email);
    const password = input.password;
    const company = input.company;
    const phone = phoneNorm(input.phone);
    const name = String(input.name ?? '').trim() || 'Gestor';

    if (!validEmail(email) || password.length < 6) {
      throw new Error('LEGACY_AUTH_INVALID');
    }
    if (!company?.id || !company?.name) {
      throw new Error('LEGACY_COMPANY_REQUIRED');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const status = String(company.subscription_status ?? 'trial').toLowerCase();
    const limit =
      company.monthly_contact_limit ??
      planLimit(company.plan_key ?? null);

    const client = await db.connect();
    let userId = '';

    try {
      await client.query('begin');

      await client.query(
        `insert into companies(
           id,name,slug,vertical,evolution_instance,
           subscription_status,access_active,trial_started_at,trial_ends_at,
           store_info_completed,whatsapp_completed,onboarding_completed,
           logo_url,instagram,legacy_supabase_migrated,
           stripe_customer_id,stripe_subscription_id,stripe_price_id,
           subscription_started_at,subscription_current_period_end,
           cancel_at_period_end,plan_key,monthly_contact_limit,monthly_contacts_used,
           created_at,updated_at
         ) values(
           $1,$2,$3,'delivery',$4,
           $5,$6,$7::timestamptz,$8::timestamptz,
           $9,$10,$11,$12,$13,false,
           $14,$15,$16,$17::timestamptz,$18::timestamptz,
           $19,$20,$21,$22,now(),now()
         )
         on conflict(id) do update set
           name = excluded.name,
           subscription_status = excluded.subscription_status,
           access_active = excluded.access_active,
           trial_started_at = coalesce(excluded.trial_started_at,companies.trial_started_at),
           trial_ends_at = coalesce(excluded.trial_ends_at,companies.trial_ends_at),
           store_info_completed = excluded.store_info_completed or companies.store_info_completed,
           whatsapp_completed = excluded.whatsapp_completed or companies.whatsapp_completed,
           onboarding_completed = excluded.onboarding_completed or companies.onboarding_completed,
           logo_url = coalesce(excluded.logo_url,companies.logo_url),
           instagram = coalesce(excluded.instagram,companies.instagram),
           stripe_customer_id = coalesce(excluded.stripe_customer_id,companies.stripe_customer_id),
           stripe_subscription_id = coalesce(excluded.stripe_subscription_id,companies.stripe_subscription_id),
           stripe_price_id = coalesce(excluded.stripe_price_id,companies.stripe_price_id),
           subscription_started_at = coalesce(excluded.subscription_started_at,companies.subscription_started_at),
           subscription_current_period_end = coalesce(excluded.subscription_current_period_end,companies.subscription_current_period_end),
           cancel_at_period_end = excluded.cancel_at_period_end,
           plan_key = coalesce(excluded.plan_key,companies.plan_key),
           monthly_contact_limit = coalesce(excluded.monthly_contact_limit,companies.monthly_contact_limit),
           monthly_contacts_used = greatest(excluded.monthly_contacts_used,companies.monthly_contacts_used),
           updated_at = now()`,
        [
          company.id,
          company.name,
          `delivery-${company.id.replace(/-/g, '').slice(0, 16)}`,
          deterministicInstance(company.id),
          status,
          accessFrom(status, company.trial_ends_at, company.subscription_current_period_end),
          company.trial_started_at ?? null,
          company.trial_ends_at ?? null,
          company.store_info_completed === true,
          company.whatsapp_completed === true,
          company.onboarding_completed === true,
          company.logo_url ?? null,
          company.instagram ?? null,
          company.stripe_customer_id ?? null,
          company.stripe_subscription_id ?? null,
          company.stripe_price_id ?? null,
          company.subscription_started_at ?? null,
          company.subscription_current_period_end ?? null,
          company.cancel_at_period_end === true,
          company.plan_key ?? null,
          limit,
          Number(company.monthly_contacts_used ?? 0)
        ]
      );

      const existing = await client.query<{ id: string }>(
        `select id::text from auth_users where email_normalized = $1 limit 1`,
        [email]
      );

      if (existing.rows[0]) {
        userId = existing.rows[0].id;
        await client.query(
          `update auth_users
           set company_id=$2,email=$3,password_hash=$4,name=$5,phone=$6,
               legacy_supabase_user_id=$7::uuid,migrated_at=now(),updated_at=now()
           where id=$1`,
          [
            userId,
            company.id,
            email,
            passwordHash,
            name,
            phone || null,
            input.legacy_user_id ?? null
          ]
        );
      } else {
        userId = randomUUID();
        await client.query(
          `insert into auth_users(
             id,company_id,email,email_normalized,password_hash,name,phone,role,
             legacy_supabase_user_id,migrated_at,created_at,updated_at
           ) values($1,$2,$3,$3,$4,$5,$6,'user',$7::uuid,now(),now(),now())`,
          [
            userId,
            company.id,
            email,
            passwordHash,
            name,
            phone || null,
            input.legacy_user_id ?? null
          ]
        );
      }

      const trialStart = company.trial_started_at || new Date().toISOString();
      const trialEnd = company.trial_ends_at ||
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      await client.query(
        `insert into trial_entitlements(
           company_id,email_normalized,phone_normalized,trial_started_at,trial_ends_at
         )
         select $1,$2,$3,$4::timestamptz,$5::timestamptz
         where not exists(
           select 1 from trial_entitlements
           where email_normalized=$2
              or ($3 <> '' and phone_normalized=$3)
         )`,
        [company.id, email, phone, trialStart, trialEnd]
      );

      await client.query(
        `insert into whatsapp_connections(company_id,instance_name,status)
         values($1,$2,'disconnected')
         on conflict(company_id) do nothing`,
        [company.id, deterministicInstance(company.id)]
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
}

export const authService = new AuthService();
