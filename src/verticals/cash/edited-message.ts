import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';
import type { Company, NormalizedMessage } from '../../core/types.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { stageCashRegistration, getCashPendingRegistration } from './confirmation.js';
import { cashParser } from './parser.js';
import { cashBatchSectionHeader } from './smart-input.js';
import type { CashTransactionInput } from './types.js';
import { findCashRecordsByQuotedMessage } from './quoted-record.js';
import { isCashProtectedNonTransaction } from './ledger.js';
import { prepareCashPocketTransactions } from './pocket-assignment.js';

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function cleanPhone(value: string): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 20);
}

function pendingKey(companyId: string, phone: string): string {
  return `arles:cash:pending-registration:${companyId}:${cleanPhone(phone)}`;
}

function segments(input: string): string[] {
  return String(input ?? '')
    .split(/\n+|;+/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function hasMovement(line: string): boolean {
  return /\b(ganhei|recebi|entrou|gastei|paguei|comprei|guardei|reservei|separei|vendi|faturei)\b/i.test(line);
}

async function parseEditedTransactions(source: string): Promise<CashTransactionInput[]> {
  if (!source.trim() || isCashProtectedNonTransaction(source)) return [];

  const lines = segments(source);
  const multi = lines.length > 1 || (source.match(/(?:r\$\s*)?\d+(?:[.,]\d{1,2})?/gi) ?? []).length > 1;
  if (!multi) {
    const parsed = await cashParser.parse(source);
    return parsed ? [parsed] : [];
  }

  const rows: CashTransactionInput[] = [];
  let section: 'income' | 'expense' | null = null;

  for (const raw of lines) {
    const directHeader = cashBatchSectionHeader(raw);
    if (directHeader) {
      section = directHeader;
      continue;
    }

    const prefixed = raw.match(/^\s*(despesas?|gastos?|sa[ií]das?|compras?|entradas?|receitas?|ganhos?|recebimentos?)\s*[:\-–—]\s*(.*)$/i);
    let line = raw;
    if (prefixed) {
      section = cashBatchSectionHeader(prefixed[1] ?? '');
      line = String(prefixed[2] ?? '').trim();
      if (!line) continue;
    }

    const candidate = section && !hasMovement(line)
      ? `${section === 'income' ? 'recebi' : 'gastei'} ${line}`
      : line;
    const parsed = await cashParser.parse(candidate);
    if (!parsed) continue;

    rows.push(section
      ? {
          ...parsed,
          type: section,
          category: section === 'income' ? 'Receita' : parsed.category === 'Receita' ? 'Outros' : parsed.category
        }
      : parsed);
    if (rows.length >= 12) break;
  }

  if (rows.length) return rows;
  const fallback = await cashParser.parse(source);
  return fallback ? [fallback] : [];
}

async function refreshUsage(companyId: string): Promise<void> {
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

async function replaceConfirmedRecords(input: {
  company: Company;
  message: NormalizedMessage;
  targetId: string;
  transactions: CashTransactionInput[];
  source: string;
}): Promise<VerticalResult> {
  const oldRows = await findCashRecordsByQuotedMessage({
    companyId: input.company.id,
    phone: input.message.phone,
    quotedMessageId: input.targetId
  });
  if (!oldRows.length) return text('✏️ Vi que a mensagem foi editada. Como ela ainda não tinha um lançamento confirmado ligado a ela, não alterei seu saldo.');

  const prepared = await prepareCashPocketTransactions(input.company.id, input.source, input.transactions);
  if (prepared.error) return text(prepared.error);

  const explicitPocket = prepared.transactions.some(transaction => Boolean(transaction.pocketId));
  const sharedOldPocket = oldRows.length && oldRows.every(row => (row.pocket_id ?? null) === (oldRows[0]?.pocket_id ?? null))
    ? oldRows[0]?.pocket_id ?? null
    : null;

  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(
      `delete from cash_transactions
       where company_id=$1 and (
         source_message_id=$2 or source_message_id like ($2 || ':item:%')
       )`,
      [input.company.id, input.targetId]
    );

    for (let index = 0; index < prepared.transactions.length; index += 1) {
      const transaction = prepared.transactions[index]!;
      const sourceId = prepared.transactions.length === 1
        ? input.targetId
        : `${input.targetId}:item:${index + 1}`;
      const preservedPocket = !explicitPocket
        ? (oldRows[index]?.pocket_id ?? sharedOldPocket ?? null)
        : null;
      const pocketId = transaction.pocketId ?? preservedPocket;

      await client.query(
        `insert into cash_transactions(
           company_id,user_phone,type,amount,category,merchant,description,
           transaction_date,source_message_id,source_message,pocket_id
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          input.company.id,
          cleanPhone(input.message.phone) || null,
          transaction.type,
          Math.round(transaction.amount * 100) / 100,
          transaction.type === 'income' ? 'Receita' : transaction.category || 'Outros',
          transaction.merchant?.trim().slice(0, 120) || null,
          transaction.description?.trim().slice(0, 500) || null,
          transaction.transactionDate,
          sourceId,
          input.source.slice(0, 1000),
          pocketId
        ]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  await refreshUsage(input.company.id);
  const total = prepared.transactions.reduce((sum, transaction) => sum + transaction.amount, 0);
  return text([
    '✏️ *Mensagem editada — registros atualizados.*',
    prepared.transactions.length === 1
      ? `${prepared.transactions[0]!.type === 'income' ? '💰 Entrada' : '💸 Saída'}: ${brl(prepared.transactions[0]!.amount)}`
      : `${prepared.transactions.length} lançamentos foram reconstruídos a partir da mensagem nova.`,
    prepared.transactions.length > 1 ? `Soma dos valores: ${brl(total)}` : '',
    '',
    'Seu saldo já considera a versão atualizada.'
  ].filter(Boolean).join('\n'));
}

export async function handleCashEditedMessage(input: {
  company: Company;
  message: NormalizedMessage;
}): Promise<VerticalResult | null> {
  const targetId = String(input.message.editedMessageId ?? '').trim();
  const source = String(input.message.text ?? '').trim();
  if (!targetId || !source || input.message.fromMe) return null;

  const parsed = await parseEditedTransactions(source);
  const pending = await getCashPendingRegistration(input.company.id, input.message.phone);

  if (pending?.sourceMessageId === targetId) {
    if (!parsed.length) {
      await redis.del(pendingKey(input.company.id, input.message.phone));
      return text('✏️ Vi sua edição. A nova mensagem não parece mais um lançamento financeiro, então cancelei o resumo que estava aguardando confirmação.');
    }

    const context: VerticalContext = {
      company: input.company,
      message: {
        ...input.message,
        messageId: targetId,
        isEdit: false,
        editedMessageId: undefined
      },
      combinedText: source
    };
    const result = await stageCashRegistration(context, parsed, source);
    return {
      ...result,
      actions: result.actions.map(action => action.type === 'text'
        ? { ...action, text: `✏️ Atualizei o que entendi da mensagem editada.\n\n${action.text}` }
        : action)
    };
  }

  if (!parsed.length) {
    const existing = await findCashRecordsByQuotedMessage({
      companyId: input.company.id,
      phone: input.message.phone,
      quotedMessageId: targetId
    });
    if (existing.length) {
      return text('✏️ Detectei a edição, mas o novo texto não descreve um lançamento financeiro com segurança. Mantive o registro anterior para não alterar seu saldo por engano.');
    }
    return null;
  }

  return await replaceConfirmedRecords({
    company: input.company,
    message: input.message,
    targetId,
    transactions: parsed,
    source
  });
}
