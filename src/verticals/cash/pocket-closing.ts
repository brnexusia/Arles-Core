import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPocketService, type CashPocket } from './cofrinhos.js';
import { normalizeCashPocketLanguage } from './pocket-language.js';

export type CashPocketClosing = {
  referenceDate: string | null;
  totalSold: number | null;
  cashCheckpoints: number[];
  cashFinal: number | null;
  receivableTotal: number | null;
  receivableItems: Array<{ amount: number; label: string }>;
  withdrawals: Array<{ amount: number; label: string }>;
  withdrawalsTotal: number;
};

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function parseMoney(raw: string): number | null {
  const clean = String(raw ?? '').replace(/r\$/gi, '').replace(/\s+/g, '').trim();
  const normalized = /^-?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(clean)
    ? clean.replace(/\./g, '').replace(',', '.')
    : clean.replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function stripDates(value: string): string {
  return String(value ?? '')
    .replace(/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
}

function moneyInLine(line: string): number | null {
  const match = stripDates(line).match(/(?:r\$\s*)?(-?\s*\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|-?\s*\d+[.,]\d{1,2})/i);
  return match?.[1] ? parseMoney(match[1]) : null;
}

function cleanLabel(line: string): string {
  return stripDates(line)
    .replace(/(?:r\$\s*)?-?\s*\d{1,3}(?:\.\d{3})*(?:,\d{1,2})/gi, ' ')
    .replace(/\b(retirou|retirei|retirada|saquei|sacou)\b/gi, ' ')
    .replace(/[()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—:;,.\s]+|[-–—:;,.\s]+$/g, '')
    .trim();
}

function referenceDate(input: string): string | null {
  const match = input.match(/\b(?:at[eé](?:\s+o)?\s+dia\s+)?(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/i);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function amountAtHeading(input: string, heading: RegExp): number | null {
  const lines = String(input ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!heading.test(normalize(line))) continue;
    const same = moneyInLine(line);
    if (same != null) return Math.abs(same);
    for (let offset = 1; offset <= 2 && index + offset < lines.length; offset += 1) {
      const next = String(lines[index + offset] ?? '').trim();
      if (!next) continue;
      const amount = moneyInLine(next);
      if (amount != null) return Math.abs(amount);
    }
  }
  return null;
}

export function isCashPocketClosingMessage(input: string): boolean {
  const value = normalize(normalizeCashPocketLanguage(input));
  const moneyCount = (stripDates(input).match(/(?:r\$\s*)?-?\s*\d{1,3}(?:\.\d{3})*(?:,\d{1,2})/gi) ?? []).length;
  if (moneyCount < 4) return false;
  const markers = [
    /\btotal\b.*\bvendid\w*/.test(value),
    /\bem caixa\b/.test(value),
    /\b(falta cobrar|a receber|devendo)\b/.test(value),
    /\b(retirou|retirada|saquei|sacou)\b/.test(value)
  ].filter(Boolean).length;
  return markers >= 3 && /\bcofrinh\w*\b/.test(value);
}

export function parseCashPocketClosing(input: string): CashPocketClosing | null {
  if (!isCashPocketClosingMessage(input)) return null;
  const lines = String(input ?? '').split(/\r?\n/);
  const cashCheckpoints: number[] = [];
  const withdrawals: Array<{ amount: number; label: string }> = [];

  for (const line of lines) {
    if (/\bem caixa\b/i.test(normalize(line))) {
      const amount = moneyInLine(line);
      if (amount != null) cashCheckpoints.push(Math.abs(amount));
    }
    if (/\b(retirou|retirei|retirada|saquei|sacou)\b/i.test(line)) {
      const amount = moneyInLine(line);
      if (amount != null && amount !== 0) withdrawals.push({ amount: Math.abs(amount), label: cleanLabel(line) || 'Retirada' });
    }
  }

  const receivableTotal = amountAtHeading(input, /\b(falta cobrar|a receber)\b/);
  const receivableItems: Array<{ amount: number; label: string }> = [];
  const receivableStart = lines.findIndex(line => /\b(falta cobrar|a receber)\b/i.test(normalize(line)));
  if (receivableStart >= 0) {
    for (let index = receivableStart + 1; index < lines.length; index += 1) {
      const line = String(lines[index] ?? '').trim();
      if (!line) continue;
      if (/\b(registre|registrar|salve|anote)\b/i.test(line) && /\bcofrinho\b/i.test(line)) break;
      if (/\b(total vendido|em caixa)\b/i.test(line)) break;
      const amount = moneyInLine(line);
      if (amount == null || amount <= 0) continue;
      const label = cleanLabel(line);
      if (label) receivableItems.push({ amount: Math.abs(amount), label });
    }
  }
  if (receivableTotal != null && receivableItems.length) {
    const detailTotal = Math.round(receivableItems.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
    if (Math.abs(detailTotal - receivableTotal) > 0.01) receivableItems.length = 0;
  }

  return {
    referenceDate: referenceDate(input),
    totalSold: amountAtHeading(input, /\btotal\b.*\bvendid\w*/),
    cashCheckpoints,
    cashFinal: cashCheckpoints.length ? cashCheckpoints[cashCheckpoints.length - 1]! : null,
    receivableTotal,
    receivableItems,
    withdrawals,
    withdrawalsTotal: Math.round(withdrawals.reduce((sum, item) => sum + item.amount, 0) * 100) / 100
  };
}

function wantsRegister(input: string): boolean {
  const value = normalize(normalizeCashPocketLanguage(input));
  return /\b(registr\w*|salv\w*|anot\w*|guarde\w*)\b/.test(value)
    && /\b(informac\w*|dados?|fechamento|valores?|isso|essas)\b/.test(value);
}

async function resolvePocket(context: VerticalContext): Promise<{ pocket: CashPocket | null; error: string | null }> {
  const canonical = normalizeCashPocketLanguage(context.combinedText);
  const mentioned = await cashPocketService.findMentioned(context.company.id, canonical);
  if (mentioned.pocket) return { pocket: mentioned.pocket, error: null };
  if (mentioned.requestedName) {
    const found = await cashPocketService.findByName(context.company.id, mentioned.requestedName);
    if (found) return { pocket: found, error: null };
    return { pocket: null, error: `Não encontrei o cofrinho *${mentioned.requestedName}*.` };
  }
  const pockets = await cashPocketService.list(context.company.id);
  if (pockets.length === 1) return { pocket: pockets[0]!, error: null };
  return { pocket: null, error: 'Qual cofrinho deve receber esse fechamento?' };
}

async function cleanupBadReceivables(companyId: string, pocketId: string, expected: number | null): Promise<number> {
  if (expected == null) return 0;
  const result = await db.query<{ id: string; amount: number; source_message: string | null }>(
    `select id::text,amount::float8,source_message
     from cash_pocket_receivables
     where company_id=$1 and pocket_id=$2 and status='pending' and source_message is not null
     order by created_at desc limit 20`,
    [companyId, pocketId]
  );
  let count = 0;
  for (const row of result.rows) {
    if (!row.source_message || !isCashPocketClosingMessage(row.source_message)) continue;
    const parsed = parseCashPocketClosing(row.source_message);
    if (!parsed?.receivableTotal || Math.abs(parsed.receivableTotal - expected) > 0.01) continue;
    if (Math.abs(Number(row.amount) - expected) <= 0.01) continue;
    await db.query(`update cash_pocket_receivables set status='cancelled',updated_at=now() where company_id=$1 and id=$2`, [companyId, row.id]);
    count += 1;
  }
  return count;
}

async function ensureReceivable(context: VerticalContext, pocket: CashPocket, closing: CashPocketClosing): Promise<void> {
  if (closing.receivableTotal == null || closing.receivableTotal <= 0) return;
  const exists = await db.query(
    `select 1 from cash_pocket_receivables
     where company_id=$1 and pocket_id=$2 and status='pending' and amount=$3 limit 1`,
    [context.company.id, pocket.id, closing.receivableTotal]
  );
  if (exists.rowCount) return;
  const detail = closing.receivableItems.length
    ? closing.receivableItems.map(item => `${brl(item.amount)} ${item.label}`).join(' + ')
    : 'Valor a receber do fechamento';
  await db.query(
    `insert into cash_pocket_receivables(company_id,pocket_id,user_phone,amount,description,source_message_id,source_message)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [context.company.id, pocket.id, String(context.message.phone ?? '').replace(/\D/g, '').slice(0, 20) || null,
      closing.receivableTotal, detail, context.message.messageId || null, context.combinedText.slice(0, 1000)]
  );
}

async function saveClosing(context: VerticalContext, pocket: CashPocket, closing: CashPocketClosing): Promise<void> {
  const details = JSON.stringify({
    cash_checkpoints: closing.cashCheckpoints,
    withdrawals: closing.withdrawals,
    receivables: closing.receivableItems
  });
  await db.query(
    `insert into cash_pocket_snapshots(
       company_id,pocket_id,user_phone,reference_date,total_sold,cash_balance,receivable_total,
       withdrawals_total,withdrawals_count,details,source_message_id,source_message
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
     on conflict (company_id,source_message_id) where source_message_id is not null
     do update set pocket_id=excluded.pocket_id,reference_date=excluded.reference_date,total_sold=excluded.total_sold,
       cash_balance=excluded.cash_balance,receivable_total=excluded.receivable_total,withdrawals_total=excluded.withdrawals_total,
       withdrawals_count=excluded.withdrawals_count,details=excluded.details,source_message=excluded.source_message,updated_at=now()`,
    [context.company.id, pocket.id, String(context.message.phone ?? '').replace(/\D/g, '').slice(0, 20) || null,
      closing.referenceDate, closing.totalSold, closing.cashFinal, closing.receivableTotal, closing.withdrawalsTotal,
      closing.withdrawals.length, details, context.message.messageId || null, context.combinedText.slice(0, 2000)]
  );
}

function dateLabel(value: string | null): string | null {
  if (!value) return null;
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
}

export async function handleCashPocketClosing(context: VerticalContext): Promise<VerticalResult | null> {
  const closing = parseCashPocketClosing(context.combinedText);
  if (!closing) return null;

  if (!wantsRegister(context.combinedText)) {
    return text([
      'Entendi que isso é um fechamento de caixa/cofrinho.',
      closing.totalSold != null ? `💰 Total vendido: ${brl(closing.totalSold)}` : '',
      closing.cashFinal != null ? `💵 Caixa final: ${brl(closing.cashFinal)}` : '',
      closing.receivableTotal != null ? `🧾 A receber: ${brl(closing.receivableTotal)}` : '',
      closing.withdrawals.length ? `↗️ Retiradas: ${closing.withdrawals.length} · ${brl(closing.withdrawalsTotal)}` : '',
      '',
      'Se quiser salvar, diga “registre essas informações no cofrinho Vendas”.'
    ].filter(Boolean).join('\n'));
  }

  const resolved = await resolvePocket(context);
  if (!resolved.pocket) return text(resolved.error ?? 'Qual cofrinho?');

  const cleaned = await cleanupBadReceivables(context.company.id, resolved.pocket.id, closing.receivableTotal);
  await saveClosing(context, resolved.pocket, closing);
  await ensureReceivable(context, resolved.pocket, closing);

  const expectedCash = closing.totalSold != null && closing.receivableTotal != null
    ? Math.round((closing.totalSold - closing.receivableTotal - closing.withdrawalsTotal) * 100) / 100
    : null;
  const reconciled = expectedCash != null && closing.cashFinal != null
    ? Math.abs(expectedCash - closing.cashFinal) <= 0.01
    : null;

  return text([
    `✅ *Fechamento salvo no cofrinho ${resolved.pocket.name}*`,
    closing.referenceDate ? `📅 Referência: até ${dateLabel(closing.referenceDate)}` : '',
    closing.totalSold != null ? `💰 Total vendido: *${brl(closing.totalSold)}*` : '',
    closing.cashFinal != null ? `💵 Caixa final: *${brl(closing.cashFinal)}*` : '',
    closing.receivableTotal != null ? `🧾 Falta cobrar: *${brl(closing.receivableTotal)}*` : '',
    closing.withdrawals.length ? `↗️ Retiradas: ${closing.withdrawals.length} · *${brl(closing.withdrawalsTotal)}*` : '',
    closing.receivableItems.length ? `👥 Pendentes: ${closing.receivableItems.map(item => `${brl(item.amount)} — ${item.label}`).join(' | ')}` : '',
    '',
    reconciled === true ? `🧮 Conferência: ${brl(closing.totalSold!)} − ${brl(closing.receivableTotal!)} − ${brl(closing.withdrawalsTotal)} = *${brl(closing.cashFinal!)}* ✅` : '',
    reconciled === false ? `⚠️ A conta não fecha: pelos valores enviados, o caixa esperado seria ${brl(expectedCash!)}. Mantive os números exatamente como informados.` : '',
    cleaned ? `🧹 Corrigi ${cleaned} pendência antiga criada por interpretar a data como dinheiro.` : '',
    '',
    'Total vendido e caixa ficaram salvos como estado do fechamento; não criei receitas/despesas falsas para esses totais.'
  ].filter(Boolean).join('\n'));
}
