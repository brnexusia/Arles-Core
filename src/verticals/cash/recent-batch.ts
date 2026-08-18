import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { interpretCashFinancialIntent } from './financial-intent.js';

export type CashRecentBatchReferenceIntent = 'summary' | 'aggregate' | null;

type RecentBatchRow = {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  merchant: string | null;
  description: string | null;
  transaction_date: string;
  source_message_id: string | null;
};

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function cleanPhone(value: string): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 20);
}

/** Compatibilidade pública. A fonte de verdade semântica é financial-intent.ts. */
export function classifyCashRecentBatchReference(input: string): CashRecentBatchReferenceIntent {
  const intent = interpretCashFinancialIntent(input);
  if (intent?.kind !== 'recent_batch') return null;
  return intent.operation === 'sum' ? 'aggregate' : 'summary';
}

export function summarizeCashRecentBatch(rows: Array<Pick<RecentBatchRow, 'type' | 'amount'>>): {
  income: number;
  expense: number;
  balance: number;
  count: number;
} {
  let income = 0;
  let expense = 0;
  for (const row of rows) {
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (row.type === 'income') income += amount;
    else expense += amount;
  }
  income = Math.round(income * 100) / 100;
  expense = Math.round(expense * 100) / 100;
  return {
    income,
    expense,
    balance: Math.round((income - expense) * 100) / 100,
    count: rows.length
  };
}

async function latestConfirmedBatch(companyId: string, phone: string): Promise<RecentBatchRow[]> {
  const normalizedPhone = cleanPhone(phone);
  const latest = await db.query<{ source_message_id: string | null }>(
    `select source_message_id
     from cash_transactions
     where company_id=$1
       and ($2::text='' or user_phone=$2)
       and source_message_id is not null
     order by created_at desc
     limit 1`,
    [companyId, normalizedPhone]
  );

  const latestSource = String(latest.rows[0]?.source_message_id ?? '').trim();
  if (!latestSource) return [];
  const baseSource = latestSource.replace(/:item:\d+$/i, '');

  const result = await db.query<RecentBatchRow>(
    `select id::text,type,amount::float8,category,merchant,description,
            transaction_date,source_message_id
     from cash_transactions
     where company_id=$1
       and ($2::text='' or user_phone=$2)
       and regexp_replace(coalesce(source_message_id,''), ':item:[0-9]+$', '')=$3
     order by created_at asc`,
    [companyId, normalizedPhone, baseSource]
  );
  return result.rows;
}

function rowLabel(row: RecentBatchRow, index: number): string {
  const icon = row.type === 'income' ? '💰' : '💸';
  const description = String(row.description ?? row.merchant ?? row.category ?? 'Lançamento').trim();
  return `${index + 1}. ${icon} ${brl(Number(row.amount))} — ${description}`;
}

/** Executa referência de lote já classificada, sem reclassificar a mensagem. */
export async function executeCashRecentBatchReference(
  context: VerticalContext,
  intent: Exclude<CashRecentBatchReferenceIntent, null>
): Promise<VerticalResult | null> {
  const rows = await latestConfirmedBatch(context.company.id, context.message.phone);
  if (!rows.length) return null;

  const summary = summarizeCashRecentBatch(rows);
  const lines = [
    '🧾 *Último envio confirmado*',
    `Lançamentos: ${summary.count}`,
    `💰 Entradas: *${brl(summary.income)}*`,
    `💸 Saídas: *${brl(summary.expense)}*`,
    `📊 Resultado líquido desse envio: *${brl(summary.balance)}*`
  ];

  if (intent === 'summary') {
    lines.push('', ...rows.slice(0, 8).map(rowLabel));
    if (rows.length > 8) lines.push(`… e mais ${rows.length - 8} lançamento${rows.length - 8 === 1 ? '' : 's'} desse mesmo envio.`);
  }

  lines.push('', 'Esse cálculo usa somente os lançamentos do seu envio confirmado mais recente, sem misturar com outros registros.');
  return text(lines.join('\n'));
}

/** Compatibilidade para chamadores legados baseados em texto. */
export async function handleCashRecentBatchReference(context: VerticalContext): Promise<VerticalResult | null> {
  const intent = classifyCashRecentBatchReference(context.combinedText);
  return intent ? await executeCashRecentBatchReference(context, intent) : null;
}
