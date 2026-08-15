import { db } from '../../infrastructure/db.js';
import { env } from '../../config/env.js';
import type { CashSummary, CashTransactionInput, CashTransactionType } from './types.js';
import { currentMonthWindow } from './time.js';

function cleanPhone(value: string): string {
  return value.replace(/\D/g, '').slice(0, 20);
}

function validDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('CASH_DATE_INVALID');
  return value;
}

function validType(value: string): CashTransactionType {
  if (value !== 'income' && value !== 'expense') throw new Error('CASH_TYPE_INVALID');
  return value;
}

function validAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999_999_999) {
    throw new Error('CASH_AMOUNT_INVALID');
  }
  return Math.round(amount * 100) / 100;
}

function planMonths(planKey: string): number {
  if (planKey === 'cash_monthly') return 1;
  if (planKey === 'cash_semiannual') return 6;
  if (planKey === 'cash_annual') return 12;
  throw new Error('CASH_PLAN_INVALID');
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function canonicalPlan(value: string): string | null {
  const normalized = String(value ?? '').toLowerCase().trim();
  if (/cash_monthly|mensal|monthly/.test(normalized)) return 'cash_monthly';
  if (/cash_semiannual|semestral|semiannual|6.?mes/.test(normalized)) return 'cash_semiannual';
  if (/cash_annual|anual|annual|12.?mes/.test(normalized)) return 'cash_annual';
  return null;
}

export class CashService {
  private async refreshMonthlyUsage(companyId: string): Promise<void> {
    await db.query(
      `update companies set monthly_contacts_used=(
         select count(*)::int from cash_transactions
         where company_id=$1
           and transaction_date >= date_trunc('month',current_date)::date
           and transaction_date < (date_trunc('month',current_date)+interval '1 month')::date
       ),updated_at=now()
       where id=$1`,
      [companyId]
    );
  }

  paymentLinks() {
    return {
      monthly: env.cashPaymentMonthlyUrl,
      semiannual: env.cashPaymentSemiannualUrl,
      annual: env.cashPaymentAnnualUrl
    };
  }

  paymentMenu(): string {
    const links = this.paymentLinks();
    const lines = [
      '📌 Mensal: R$4,99/mês' + (links.monthly ? `\n👉 ${links.monthly}` : ''),
      '📌 Semestral: R$24,90 (= R$4,15/mês)' + (links.semiannual ? `\n👉 ${links.semiannual}` : ''),
      '🏆 Anual — Mais popular: R$39,90 (= R$3,33/mês — 2 meses grátis 🎁)' + (links.annual ? `\n👉 ${links.annual}` : '')
    ];
    return lines.join('\n\n');
  }

  async rememberOwnerPhone(companyId: string, phone: string): Promise<void> {
    const normalized = cleanPhone(phone);
    if (!normalized) return;
    await db.query(
      `insert into cash_settings(company_id,owner_phone)
       values($1,$2)
       on conflict(company_id) do update set
         owner_phone=coalesce(cash_settings.owner_phone,excluded.owner_phone),updated_at=now()`,
      [companyId, normalized]
    );
  }

  async beginOnboarding(companyId: string): Promise<void> {
    await db.query(
      `update cash_settings set onboarding_state='awaiting_name',updated_at=now()
       where company_id=$1 and onboarding_state='welcome'`,
      [companyId]
    );
  }

  async settings(companyId: string) {
    const result = await db.query(
      `select
         cs.owner_phone,cs.owner_name,cs.onboarding_state,cs.onboarding_completed_at,
         cs.weekly_report_enabled,cs.monthly_report_enabled,
         c.subscription_status,c.access_active,c.trial_started_at,c.trial_ends_at,
         c.subscription_current_period_end,c.plan_key
       from companies c
       left join cash_settings cs on cs.company_id=c.id
       where c.id=$1 limit 1`,
      [companyId]
    );
    const row = result.rows[0];
    if (!row) throw new Error('COMPANY_NOT_FOUND');
    return {
      owner_phone: row.owner_phone ?? null,
      owner_name: row.owner_name ?? null,
      onboarding_state: row.onboarding_state ?? 'active',
      onboarding_completed_at: row.onboarding_completed_at ?? null,
      weekly_report_enabled: row.weekly_report_enabled !== false,
      monthly_report_enabled: row.monthly_report_enabled !== false,
      subscription_status: String(row.subscription_status ?? 'expired'),
      access_active: row.access_active === true,
      trial_started_at: row.trial_started_at ? new Date(row.trial_started_at) : null,
      trial_ends_at: row.trial_ends_at ? new Date(row.trial_ends_at) : null,
      subscription_current_period_end: row.subscription_current_period_end
        ? new Date(row.subscription_current_period_end)
        : null,
      plan_key: row.plan_key ?? null,
      official_phone: env.cashOfficialNumber || null,
      managed_by_arles: true
    };
  }

  async completeOnboarding(companyId: string, name: string) {
    const cleanName = name.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (cleanName.length < 2) throw new Error('CASH_NAME_INVALID');

    const result = await db.query(
      `update cash_settings set
         owner_name=$2,onboarding_state='active',onboarding_completed_at=now(),updated_at=now()
       where company_id=$1
       returning owner_phone,owner_name,onboarding_state,onboarding_completed_at`,
      [companyId, cleanName]
    );
    if (!result.rows[0]) throw new Error('CASH_SETTINGS_NOT_FOUND');

    await db.query(
      `update company_verticals set onboarding_completed=true,updated_at=now()
       where company_id=$1 and vertical_id='cash'`,
      [companyId]
    );
    return result.rows[0];
  }

  async accessState(companyId: string) {
    const settings = await this.settings(companyId);
    const now = Date.now();
    const trialActive =
      settings.subscription_status === 'trial' &&
      !!settings.trial_ends_at &&
      settings.trial_ends_at.getTime() > now;
    const paidActive =
      settings.subscription_status === 'active' &&
      (!settings.subscription_current_period_end || settings.subscription_current_period_end.getTime() > now);

    if (settings.subscription_status === 'trial' && settings.trial_ends_at && !trialActive) {
      await db.query(
        `update companies set subscription_status='expired',access_active=false,updated_at=now()
         where id=$1 and subscription_status='trial'`,
        [companyId]
      );
      return { ...settings, subscription_status: 'expired', access_active: false, hasAccess: false };
    }

    if (
      settings.subscription_status === 'active' &&
      settings.subscription_current_period_end &&
      settings.subscription_current_period_end.getTime() <= now
    ) {
      await db.query(
        `update companies set subscription_status='expired',access_active=false,updated_at=now()
         where id=$1 and subscription_status='active'`,
        [companyId]
      );
      return { ...settings, subscription_status: 'expired', access_active: false, hasAccess: false };
    }

    return { ...settings, hasAccess: trialActive || paidActive };
  }

  async expireTrial(companyId: string): Promise<void> {
    await db.query(
      `update companies set subscription_status='expired',access_active=false,updated_at=now()
       where id=$1 and subscription_status='trial' and trial_ends_at <= now()`,
      [companyId]
    );
  }

  async saveSettings(companyId: string, body: Record<string, unknown>) {
    const phone = cleanPhone(String(body.owner_phone ?? '')) || null;
    if (phone) {
      const duplicate = await db.query(
        `select 1
         from cash_settings
         where company_id <> $1
           and (
             regexp_replace(coalesce(owner_phone,''),'[^0-9]','','g') = $2
             or right(regexp_replace(coalesce(owner_phone,''),'[^0-9]','','g'),11) = right($2,11)
           )
         limit 1`,
        [companyId, phone]
      );
      if (duplicate.rowCount) throw new Error('CASH_PHONE_ALREADY_REGISTERED');
    }
    const weekly = body.weekly_report_enabled !== false;
    const monthly = body.monthly_report_enabled !== false;
    const result = await db.query(
      `insert into cash_settings(
         company_id,owner_phone,weekly_report_enabled,monthly_report_enabled
       ) values($1,$2,$3,$4)
       on conflict(company_id) do update set
         owner_phone=coalesce(excluded.owner_phone,cash_settings.owner_phone),
         weekly_report_enabled=excluded.weekly_report_enabled,
         monthly_report_enabled=excluded.monthly_report_enabled,
         updated_at=now()
       returning owner_phone,owner_name,onboarding_state,weekly_report_enabled,monthly_report_enabled`,
      [companyId, phone, weekly, monthly]
    );
    return {
      ...result.rows[0],
      official_phone: env.cashOfficialNumber || null,
      managed_by_arles: true
    };
  }

  async createTransaction(input: {
    companyId: string;
    phone?: string;
    sourceMessageId?: string;
    sourceMessage?: string;
    transaction: CashTransactionInput;
  }) {
    const transaction = input.transaction;
    const result = await db.query(
      `insert into cash_transactions(
         company_id,user_phone,type,amount,category,merchant,description,
         transaction_date,source_message_id,source_message
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict(company_id,source_message_id) do update set
         source_message=excluded.source_message
       returning id::text,type,amount::float8,category,merchant,description,
                 transaction_date,created_at`,
      [
        input.companyId,
        cleanPhone(input.phone ?? '') || null,
        validType(transaction.type),
        validAmount(transaction.amount),
        transaction.category.trim().slice(0, 80) || 'Outros',
        transaction.merchant.trim().slice(0, 120) || null,
        transaction.description.trim().slice(0, 500) || null,
        validDate(transaction.transactionDate),
        input.sourceMessageId?.trim() || null,
        input.sourceMessage?.trim().slice(0, 1000) || null
      ]
    );
    await this.refreshMonthlyUsage(input.companyId);
    return result.rows[0];
  }

  async listTransactions(companyId: string, query: Record<string, unknown>) {
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);
    const type = query.type === 'income' || query.type === 'expense' ? query.type : null;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from ?? '')) ? String(query.from) : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to ?? '')) ? String(query.to) : null;
    const result = await db.query(
      `select id::text,type,amount::float8,category,merchant,description,
              transaction_date,user_phone,created_at,updated_at
       from cash_transactions
       where company_id=$1
         and ($2::text is null or type=$2)
         and ($3::date is null or transaction_date >= $3::date)
         and ($4::date is null or transaction_date <= $4::date)
       order by transaction_date desc,created_at desc
       limit $5 offset $6`,
      [companyId, type, from, to, limit, offset]
    );
    return result.rows;
  }

  async listRecent(companyId: string, phone: string, limit = 5) {
    const normalized = cleanPhone(phone);
    const result = await db.query(
      `select id::text,type,amount::float8,category,merchant,description,transaction_date,created_at
       from cash_transactions
       where company_id=$1 and ($2::text='' or user_phone=$2)
       order by transaction_date desc,created_at desc
       limit $3`,
      [companyId, normalized, Math.max(1, Math.min(20, limit))]
    );
    return result.rows;
  }

  async updateTransaction(companyId: string, id: string, body: Record<string, unknown>) {
    const result = await db.query(
      `update cash_transactions set
         type=coalesce($3,type),
         amount=coalesce($4,amount),
         category=coalesce($5,category),
         merchant=$6,
         description=$7,
         transaction_date=coalesce($8,transaction_date),
         updated_at=now()
       where company_id=$1 and id=$2
       returning id::text,type,amount::float8,category,merchant,description,
                 transaction_date,created_at,updated_at`,
      [
        companyId,
        id,
        body.type == null ? null : validType(String(body.type)),
        body.amount == null ? null : validAmount(body.amount),
        body.category == null ? null : String(body.category).trim().slice(0, 80) || 'Outros',
        body.merchant == null ? null : String(body.merchant).trim().slice(0, 120) || null,
        body.description == null ? null : String(body.description).trim().slice(0, 500) || null,
        body.transaction_date == null ? null : validDate(String(body.transaction_date))
      ]
    );
    if (!result.rows[0]) throw new Error('CASH_TRANSACTION_NOT_FOUND');
    await this.refreshMonthlyUsage(companyId);
    return result.rows[0];
  }

  async deleteTransaction(companyId: string, id: string): Promise<void> {
    const result = await db.query(
      `delete from cash_transactions where company_id=$1 and id=$2`,
      [companyId, id]
    );
    if (!result.rowCount) throw new Error('CASH_TRANSACTION_NOT_FOUND');
    await this.refreshMonthlyUsage(companyId);
  }

  async deleteLast(companyId: string, phone: string) {
    const result = await db.query(
      `delete from cash_transactions
       where id=(
         select id from cash_transactions
         where company_id=$1 and ($2::text='' or user_phone=$2)
         order by created_at desc limit 1
       )
       returning id::text,type,amount::float8,category,merchant,description,transaction_date`,
      [companyId, cleanPhone(phone)]
    );
    if (result.rows[0]) await this.refreshMonthlyUsage(companyId);
    return result.rows[0] ?? null;
  }

  async summary(companyId: string, from: string, to: string): Promise<CashSummary> {
    const totals = await db.query<{
      income: number;
      expense: number;
      count: number;
    }>(
      `select
         coalesce(sum(amount) filter(where type='income'),0)::float8 as income,
         coalesce(sum(amount) filter(where type='expense'),0)::float8 as expense,
         count(*)::int as count
       from cash_transactions
       where company_id=$1 and transaction_date between $2::date and $3::date`,
      [companyId, validDate(from), validDate(to)]
    );
    const categories = await db.query<{ category: string; amount: number }>(
      `select category,sum(amount)::float8 as amount
       from cash_transactions
       where company_id=$1 and type='expense'
         and transaction_date between $2::date and $3::date
       group by category order by amount desc limit 8`,
      [companyId, from, to]
    );
    const row = totals.rows[0] ?? { income: 0, expense: 0, count: 0 };
    return {
      income: Number(row.income || 0),
      expense: Number(row.expense || 0),
      balance: Number(row.income || 0) - Number(row.expense || 0),
      count: Number(row.count || 0),
      categories: categories.rows.map(item => ({
        category: item.category,
        amount: Number(item.amount || 0)
      }))
    };
  }

  async overview(companyId: string) {
    const period = currentMonthWindow();
    const [summary, recent, settings] = await Promise.all([
      this.summary(companyId, period.from, period.to),
      this.listTransactions(companyId, { limit: 8 }),
      this.settings(companyId)
    ]);
    return { period, summary, recent, settings };
  }

  async companyChannel(companyId: string) {
    const result = await db.query<{ evolution_instance: string; timezone: string }>(
      `select evolution_instance,timezone from companies where id=$1 limit 1`,
      [companyId]
    );
    return result.rows[0] ?? null;
  }

  async applyExternalPayment(input: {
    eventId: string;
    provider: string;
    phone?: string;
    companyId?: string;
    plan: string;
    status: string;
    amountCents?: number | null;
    payload?: Record<string, unknown>;
  }) {
    const eventId = input.eventId.trim();
    const provider = input.provider.trim().toLowerCase() || 'external';
    const phone = cleanPhone(input.phone ?? '');
    const planKey = canonicalPlan(input.plan);
    const status = input.status.toLowerCase().trim();
    if (!eventId) throw new Error('CASH_PAYMENT_EVENT_INVALID');
    if (!planKey) throw new Error('CASH_PLAN_INVALID');

    const approved = /approved|paid|complete|completed|purchase_approved|active/.test(status);
    const revoked = /refund|refunded|chargeback|canceled|cancelled|expired/.test(status);
    if (!approved && !revoked) return { ignored: true };

    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`cash-payment:${eventId}`]);

      const seen = await client.query(`select 1 from cash_payment_events where id=$1 limit 1`, [eventId]);
      if (seen.rowCount) {
        await client.query('commit');
        return { duplicate: true };
      }

      const found = await client.query<{ id: string; subscription_current_period_end: Date | null }>(
        `select c.id::text,c.subscription_current_period_end
         from companies c
         left join cash_settings cs on cs.company_id=c.id
         where coalesce(c.active_vertical_id,c.vertical)='cash'
           and (
             ($1::text <> '' and c.id::text=$1)
             or ($2::text <> '' and right(regexp_replace(coalesce(cs.owner_phone,''),'[^0-9]','','g'),11)=right($2,11))
           )
         order by case when c.id::text=$1 then 0 else 1 end
         limit 1`,
        [input.companyId?.trim() ?? '', phone]
      );
      const company = found.rows[0];
      if (!company) throw new Error('CASH_PAYMENT_ACCOUNT_NOT_FOUND');

      if (approved) {
        const now = new Date();
        const currentEnd = company.subscription_current_period_end
          ? new Date(company.subscription_current_period_end)
          : null;
        const base = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
        const periodEnd = addMonths(base, planMonths(planKey));
        await client.query(
          `update companies set
             subscription_status='active',access_active=true,plan_key=$2,
             subscription_started_at=coalesce(subscription_started_at,now()),
             subscription_current_period_end=$3,cancel_at_period_end=false,updated_at=now()
           where id=$1`,
          [company.id, planKey, periodEnd]
        );
      } else if (revoked) {
        await client.query(
          `update companies set subscription_status='canceled',access_active=false,updated_at=now()
           where id=$1`,
          [company.id]
        );
      }

      await client.query(
        `insert into cash_payment_events(id,provider,company_id,owner_phone,plan_key,status,amount_cents,payload)
         values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          eventId,
          provider,
          company.id,
          phone || null,
          planKey,
          status,
          Number.isInteger(input.amountCents) ? input.amountCents : null,
          JSON.stringify(input.payload ?? {})
        ]
      );

      await client.query('commit');
      return { companyId: company.id, active: approved, planKey };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const cashService = new CashService();
