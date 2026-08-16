import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../../infrastructure/db.js';

const CODE_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function cleanPhone(value: string): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 20);
}

function right11(value: string): string {
  return cleanPhone(value).slice(-11);
}

export function normalizeCashEmail(value: string): string {
  return String(value ?? '').trim().toLowerCase().slice(0, 254);
}

export function isValidCashEmail(value: string): boolean {
  const email = normalizeCashEmail(value);
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function canonicalPlan(value: string): 'cash_monthly' | 'cash_semiannual' | 'cash_annual' | null {
  const normalized = String(value ?? '').toLowerCase().trim();
  if (/cash_monthly|mensal|monthly/.test(normalized)) return 'cash_monthly';
  if (/cash_semiannual|semestral|semiannual|6.?mes/.test(normalized)) return 'cash_semiannual';
  if (/cash_annual|anual|annual|12.?mes/.test(normalized)) return 'cash_annual';
  return null;
}

function planMonths(planKey: string): number {
  if (planKey === 'cash_monthly') return 1;
  if (planKey === 'cash_semiannual') return 6;
  if (planKey === 'cash_annual') return 12;
  throw new Error('CASH_PLAN_INVALID');
}

export function cashPlanLabel(planKey: string): string {
  if (planKey === 'cash_monthly') return 'Mensal';
  if (planKey === 'cash_semiannual') return 'Semestral';
  if (planKey === 'cash_annual') return 'Anual';
  return 'Arles Cash';
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function codeHash(code: string): string {
  return createHash('sha256').update(code.toUpperCase()).digest('hex');
}

function randomCodeBody(length = 8): string {
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return result;
}

function generateActivationCode(): string {
  return `CASH-${randomCodeBody(8)}`;
}

export function extractActivationCode(input: string): string | null {
  const match = String(input ?? '')
    .trim()
    .toUpperCase()
    .match(/^(?:C[ÓO]DIGO\s*[:=-]?\s*)?(CASH[- ]?[A-HJ-NP-Z2-9]{8})[!. ]*$/i);
  if (!match?.[1]) return null;
  const compact = match[1].replace(/\s+/g, '-');
  return compact.startsWith('CASH-') ? compact : `CASH-${compact.slice(4)}`;
}

type PaymentInput = {
  eventId: string;
  provider: string;
  phone?: string;
  email?: string;
  companyId?: string;
  plan: string;
  status: string;
  amountCents?: number | null;
  payload?: Record<string, unknown>;
};

type AccountRow = {
  id: string;
  owner_phone: string | null;
  owner_email: string | null;
};

async function findAccount(client: PoolClient, input: { companyId?: string; phone?: string; email?: string }): Promise<AccountRow | null> {
  const phone = cleanPhone(input.phone ?? '');
  const email = normalizeCashEmail(input.email ?? '');
  const result = await client.query<AccountRow>(
    `select c.id::text,cs.owner_phone,cs.owner_email
     from companies c
     left join cash_settings cs on cs.company_id=c.id
     where coalesce(c.active_vertical_id,c.vertical)='cash'
       and (
         ($1::text <> '' and c.id::text=$1)
         or ($2::text <> '' and right(regexp_replace(coalesce(cs.owner_phone,''),'[^0-9]','','g'),11)=right($2,11))
         or ($3::text <> '' and lower(coalesce(cs.owner_email,''))=$3)
       )
     order by
       case
         when c.id::text=$1 then 0
         when $2::text <> '' and right(regexp_replace(coalesce(cs.owner_phone,''),'[^0-9]','','g'),11)=right($2,11) then 1
         else 2
       end
     limit 1`,
    [String(input.companyId ?? '').trim(), phone, email]
  );
  return result.rows[0] ?? null;
}

async function issueCode(client: PoolClient, input: {
  eventId: string;
  company: AccountRow;
  planKey: string;
}): Promise<{ activationCode: string; expiresAt: Date }> {
  const accountPhone = cleanPhone(input.company.owner_phone ?? '');
  if (accountPhone.length < 10) throw new Error('CASH_PAYMENT_ACCOUNT_PHONE_MISSING');

  const activationCode = generateActivationCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const hash = codeHash(activationCode);
  await client.query(
    `insert into cash_activation_codes(
       payment_event_id,company_id,owner_phone,owner_email,plan_key,code_hash,expires_at
     ) values($1,$2,$3,$4,$5,$6,$7)
     on conflict(payment_event_id) do update set
       code_hash=excluded.code_hash,
       expires_at=excluded.expires_at,
       updated_at=now()
     where cash_activation_codes.redeemed_at is null`,
    [
      input.eventId,
      input.company.id,
      accountPhone,
      normalizeCashEmail(input.company.owner_email ?? '') || null,
      input.planKey,
      hash,
      expiresAt
    ]
  );
  return { activationCode, expiresAt };
}

export class CashActivationService {
  async registerPayment(input: PaymentInput) {
    const eventId = String(input.eventId ?? '').trim();
    const provider = String(input.provider ?? 'external').trim().toLowerCase() || 'external';
    const phone = cleanPhone(input.phone ?? '');
    const email = normalizeCashEmail(input.email ?? '');
    const planKey = canonicalPlan(input.plan);
    const status = String(input.status ?? '').toLowerCase().trim();

    if (!eventId) throw new Error('CASH_PAYMENT_EVENT_INVALID');
    if (!planKey) throw new Error('CASH_PLAN_INVALID');

    const approved = /approved|paid|complete|completed|purchase_approved|active/.test(status);
    const revoked = /refund|refunded|chargeback|canceled|cancelled|expired/.test(status);
    if (!approved && !revoked) return { ignored: true } as const;

    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`cash-payment:${eventId}`]);

      const company = await findAccount(client, {
        companyId: input.companyId,
        phone,
        email
      });
      if (!company) throw new Error('CASH_PAYMENT_ACCOUNT_NOT_FOUND');

      const seen = await client.query<{ id: string; status: string }>(
        `select id,status from cash_payment_events where id=$1 limit 1`,
        [eventId]
      );

      if (revoked) {
        if (!seen.rowCount) {
          await client.query(
            `insert into cash_payment_events(
               id,provider,company_id,owner_phone,owner_email,plan_key,status,amount_cents,payload
             ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
            [
              eventId,
              provider,
              company.id,
              phone || company.owner_phone || null,
              email || company.owner_email || null,
              planKey,
              status,
              Number.isInteger(input.amountCents) ? input.amountCents : null,
              JSON.stringify(input.payload ?? {})
            ]
          );
        }
        await client.query(
          `update companies set subscription_status='canceled',access_active=false,updated_at=now()
           where id=$1`,
          [company.id]
        );
        await client.query('commit');
        return { companyId: company.id, active: false, revoked: true, planKey } as const;
      }

      if (!seen.rowCount) {
        await client.query(
          `insert into cash_payment_events(
             id,provider,company_id,owner_phone,owner_email,plan_key,status,amount_cents,payload
           ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            eventId,
            provider,
            company.id,
            phone || company.owner_phone || null,
            email || company.owner_email || null,
            planKey,
            status,
            Number.isInteger(input.amountCents) ? input.amountCents : null,
            JSON.stringify(input.payload ?? {})
          ]
        );
      }

      const existingCode = await client.query<{ redeemed_at: Date | null }>(
        `select redeemed_at from cash_activation_codes where payment_event_id=$1 limit 1`,
        [eventId]
      );
      if (existingCode.rows[0]?.redeemed_at) {
        await client.query('commit');
        return { companyId: company.id, duplicate: true, alreadyRedeemed: true, planKey } as const;
      }

      // Em retry do webhook, rotacionamos um código ainda não usado. Isso permite
      // recuperar um envio de WhatsApp que tenha falhado sem guardar código em texto no banco.
      const issued = await issueCode(client, { eventId, company, planKey });
      await client.query('commit');
      return {
        companyId: company.id,
        ownerPhone: cleanPhone(company.owner_phone ?? phone),
        ownerEmail: normalizeCashEmail(company.owner_email ?? email) || null,
        pendingActivation: true,
        planKey,
        activationCode: issued.activationCode,
        expiresAt: issued.expiresAt
      } as const;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async redeem(companyId: string, phone: string, rawCode: string) {
    const normalizedPhone = cleanPhone(phone);
    const activationCode = extractActivationCode(rawCode);
    if (!activationCode) throw new Error('CASH_ACTIVATION_CODE_INVALID');
    const hash = codeHash(activationCode);

    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`cash-code:${hash}`]);

      const result = await client.query<{
        id: string;
        company_id: string;
        owner_phone: string;
        plan_key: string;
        expires_at: Date;
        redeemed_at: Date | null;
      }>(
        `select id::text,company_id::text,owner_phone,plan_key,expires_at,redeemed_at
         from cash_activation_codes
         where code_hash=$1
         limit 1`,
        [hash]
      );
      const code = result.rows[0];
      if (!code) throw new Error('CASH_ACTIVATION_CODE_INVALID');
      if (code.redeemed_at) throw new Error('CASH_ACTIVATION_CODE_USED');
      if (new Date(code.expires_at).getTime() <= Date.now()) throw new Error('CASH_ACTIVATION_CODE_EXPIRED');
      if (String(code.company_id) !== String(companyId)) throw new Error('CASH_ACTIVATION_CODE_ACCOUNT_MISMATCH');
      if (right11(code.owner_phone) !== right11(normalizedPhone)) throw new Error('CASH_ACTIVATION_CODE_PHONE_MISMATCH');

      const companyResult = await client.query<{ subscription_current_period_end: Date | null }>(
        `select subscription_current_period_end from companies where id=$1 for update`,
        [companyId]
      );
      if (!companyResult.rows[0]) throw new Error('COMPANY_NOT_FOUND');

      const now = new Date();
      const currentEnd = companyResult.rows[0].subscription_current_period_end
        ? new Date(companyResult.rows[0].subscription_current_period_end)
        : null;
      const base = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
      const periodEnd = addMonths(base, planMonths(code.plan_key));

      await client.query(
        `update companies set
           subscription_status='active',access_active=true,plan_key=$2,
           subscription_started_at=coalesce(subscription_started_at,now()),
           subscription_current_period_end=$3,cancel_at_period_end=false,updated_at=now()
         where id=$1`,
        [companyId, code.plan_key, periodEnd]
      );
      await client.query(
        `update cash_activation_codes set redeemed_at=now(),updated_at=now() where id=$1`,
        [code.id]
      );
      await client.query('commit');
      return { planKey: code.plan_key, periodEnd };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const cashActivation = new CashActivationService();
