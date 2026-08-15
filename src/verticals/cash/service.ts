import { db } from '../../infrastructure/db.js';
import type { CashSummary, CashTransactionInput, CashTransactionType } from './types.js';

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

  async settings(companyId: string) {
    const result = await db.query(
      `select owner_phone,weekly_report_enabled,monthly_report_enabled
       from cash_settings where company_id=$1 limit 1`,
      [companyId]
    );
    return result.rows[0] ?? {
      owner_phone: null,
      weekly_report_enabled: true,
      monthly_report_enabled: true
    };
  }

  async saveSettings(companyId: string, body: Record<string, unknown>) {
    const phone = cleanPhone(String(body.owner_phone ?? '')) || null;
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
       returning owner_phone,weekly_report_enabled,monthly_report_enabled`,
      [companyId, phone, weekly, monthly]
    );
    return result.rows[0];
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
    if (input.phone) await this.rememberOwnerPhone(input.companyId, input.phone);
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
    const today = new Date();
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      .toISOString().slice(0, 10);
    const todayIso = today.toISOString().slice(0, 10);
    const [summary, recent, settings] = await Promise.all([
      this.summary(companyId, monthStart, todayIso),
      this.listTransactions(companyId, { limit: 8 }),
      this.settings(companyId)
    ]);
    return { period: { from: monthStart, to: todayIso }, summary, recent, settings };
  }

  async companyChannel(companyId: string) {
    const result = await db.query<{ evolution_instance: string; timezone: string }>(
      `select evolution_instance,timezone from companies where id=$1 limit 1`,
      [companyId]
    );
    return result.rows[0] ?? null;
  }
}

export const cashService = new CashService();
