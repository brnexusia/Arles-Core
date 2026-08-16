import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { asksHowToManage, normalizeCashText } from './management.js';
import { deterministicCashQuery, type CashQueryFilters } from './query.js';

const TTL_SECONDS = 15 * 60;
const RECORD_WORDS = '(?:registros?|registos?|lancamentos?|gastos?|despesas?|receitas?|movimentacoes?)';

type CashBulkDeletionIntent =
  | { kind: 'all' }
  | { kind: 'last-list'; count: number | null };

type PendingCashDeletion =
  | { kind: 'all'; expectedCount: number }
  | { kind: 'ids'; ids: string[]; expectedCount: number; sourceQuery: string };

type CashDeletionRow = {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  merchant: string | null;
  description: string | null;
  transaction_date: string;
  created_at: string;
};

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return normalizeCashText(value);
}

function phoneDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function pendingKey(companyId: string, phone: string): string {
  return `arles:cash:pending-deletion:${companyId}:${phoneDigits(phone)}`;
}

function queryKey(companyId: string, phone: string): string {
  return `arles:cash:query:${companyId}:${phoneDigits(phone)}`;
}

function hasDeleteVerb(value: string): boolean {
  return /\b(apag|exclu|remov|retir|delet)\w*/.test(value);
}

export function isCashDeletionCommand(input: string): boolean {
  const value = normalize(input);
  if (asksHowToManage(value) || !hasDeleteVerb(value)) return false;
  return new RegExp(`\\b${RECORD_WORDS}\\b`).test(value)
    || /\b(?:esses|essas|estes|estas)\s+\d{1,3}\b/.test(value)
    || /\b(?:essa|esta)\s+lista\b/.test(value);
}

export function parseCashBulkDeletionIntent(input: string): CashBulkDeletionIntent | null {
  const value = normalize(input);
  if (!isCashDeletionCommand(value)) return null;

  const allMine = new RegExp(`\\b(?:todos|todas)\\s+(?:(?:os|as)\\s+)?(?:(?:meus|minhas)\\s+)?${RECORD_WORDS}\\b`);
  if (allMine.test(value) && !/\b(?:esses|essas|estes|estas)\b/.test(value)) {
    return { kind: 'all' };
  }

  const visibleCount = value.match(new RegExp(`\\b(?:esses|essas|estes|estas|os|as)?\\s*(\\d{1,3})\\s+${RECORD_WORDS}\\b`));
  if (visibleCount?.[1]) {
    const count = Number(visibleCount[1]);
    if (count >= 2 && count <= 100) return { kind: 'last-list', count };
  }

  const visibleAll = new RegExp(`\\b(?:todos|todas)\\s+(?:esses|essas|estes|estas)\\s+${RECORD_WORDS}\\b`);
  if (visibleAll.test(value) || /\b(?:esses|essas|estes|estas)\s+(?:registros?|registos?|lancamentos?|gastos?|despesas?|receitas?|movimentacoes?)\b/.test(value) || /\b(?:essa|esta)\s+lista\b/.test(value)) {
    return { kind: 'last-list', count: null };
  }

  return null;
}

export function isCashDeletionConfirmation(input: string): boolean {
  const value = normalize(input).replace(/[!.]+$/g, '').trim();
  return /^(sim|confirmo|confirmar|confirma|pode apagar|pode excluir|pode remover|apaga|exclui|remove|isso mesmo|esta certo|ta certo|correto|pode)$/.test(value);
}

export function isCashDeletionCancellation(input: string): boolean {
  const value = normalize(input).replace(/[!.]+$/g, '').trim();
  return /^(nao|cancelar|cancela|cancele|deixa pra la|esquece|nao apaga|nao exclui|nao remove)$/.test(value);
}

function normalizeTerm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchExpression(): string {
  return `translate(lower(concat_ws(' ',coalesce(merchant,''),coalesce(description,''),coalesce(category,''),coalesce(source_message,''))),
    'áàâãäéèêëíìîïóòôõöúùûüç',
    'aaaaaeeeeiiiiooooouuuuc')`;
}

async function rowsFromLastQuery(companyId: string, queryText: string): Promise<CashDeletionRow[]> {
  const filters = deterministicCashQuery(queryText);
  if (!filters) return [];
  return await rowsForFilters(companyId, filters);
}

async function rowsForFilters(companyId: string, filters: CashQueryFilters): Promise<CashDeletionRow[]> {
  const type = filters.type === 'all' ? null : filters.type;
  const term = filters.term ? normalizeTerm(filters.term) || null : null;
  const sortSql = filters.sort === 'amount_desc'
    ? 'amount desc, transaction_date desc, created_at desc'
    : filters.sort === 'amount_asc'
      ? 'amount asc, transaction_date desc, created_at desc'
      : 'transaction_date desc, created_at desc';

  const result = await db.query<CashDeletionRow>(
    `select id::text,type,amount::float8,category,merchant,description,transaction_date,created_at
     from cash_transactions
     where company_id=$1
       and transaction_date between $2::date and $3::date
       and ($4::text is null or type=$4)
       and ($5::text is null or category=$5)
       and ($6::numeric is null or amount >= $6::numeric)
       and ($7::numeric is null or amount <= $7::numeric)
       and ($8::text is null or ${searchExpression()} like '%' || $8 || '%')
     order by ${sortSql}
     limit $9`,
    [
      companyId,
      filters.from,
      filters.to,
      type,
      filters.category,
      filters.minAmount,
      filters.maxAmount,
      term,
      Math.min(100, Math.max(1, filters.limit))
    ]
  );
  return result.rows;
}

async function countAll(companyId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    'select count(*)::int as count from cash_transactions where company_id=$1',
    [companyId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function savePending(companyId: string, phone: string, pending: PendingCashDeletion): Promise<void> {
  await redis.set(pendingKey(companyId, phone), JSON.stringify(pending), 'EX', TTL_SECONDS);
}

async function getPending(companyId: string, phone: string): Promise<PendingCashDeletion | null> {
  const raw = await redis.get(pendingKey(companyId, phone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingCashDeletion;
    if (parsed.kind === 'all' && parsed.expectedCount >= 0) return parsed;
    if (parsed.kind === 'ids' && Array.isArray(parsed.ids) && parsed.ids.length) return parsed;
  } catch {
    // Ignore invalid/expired payloads.
  }
  return null;
}

async function clearPending(companyId: string, phone: string): Promise<void> {
  await redis.del(pendingKey(companyId, phone));
}

async function refreshMonthlyUsage(companyId: string): Promise<void> {
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

async function deletePending(companyId: string, pending: PendingCashDeletion): Promise<number> {
  const result = pending.kind === 'all'
    ? await db.query('delete from cash_transactions where company_id=$1 returning id', [companyId])
    : await db.query(
        'delete from cash_transactions where company_id=$1 and id::text = any($2::text[]) returning id',
        [companyId, pending.ids]
      );
  await refreshMonthlyUsage(companyId);
  return Number(result.rowCount ?? 0);
}

export async function handleCashBulkDeletionCommand(context: VerticalContext): Promise<VerticalResult | null> {
  const intent = parseCashBulkDeletionIntent(context.combinedText);
  if (!intent) return null;

  if (intent.kind === 'all') {
    const count = await countAll(context.company.id);
    if (!count) return text('Você não tem registros para apagar.');
    await savePending(context.company.id, context.message.phone, { kind: 'all', expectedCount: count });
    return text([
      `⚠️ Você quer apagar TODOS os seus ${count} registro${count === 1 ? '' : 's'}?`,
      'Essa ação não pode ser desfeita.',
      '',
      'Responda *sim* para apagar ou *não* para cancelar.'
    ].join('\n'));
  }

  const lastQuery = await redis.get(queryKey(context.company.id, context.message.phone));
  if (!lastQuery) {
    return text('Não tenho uma lista recente para saber quais registros são “esses”. Peça a lista novamente e depois diga quais quer apagar.');
  }

  const rows = await rowsFromLastQuery(context.company.id, lastQuery);
  if (!rows.length) return text('A última lista não tem mais registros para apagar.');

  if (intent.count != null && rows.length < intent.count) {
    return text(`A última lista tem ${rows.length} registro${rows.length === 1 ? '' : 's'}, mas você pediu para apagar ${intent.count}. Peça a lista novamente para eu não excluir o item errado.`);
  }

  const selected = intent.count == null ? rows : rows.slice(0, intent.count);
  const ids = selected.map(row => row.id);
  await savePending(context.company.id, context.message.phone, {
    kind: 'ids',
    ids,
    expectedCount: ids.length,
    sourceQuery: lastQuery
  });

  return text([
    `🗑️ Você quer apagar ${ids.length === 1 ? 'este registro' : `estes ${ids.length} registros`} da lista que acabei de mostrar?`,
    '',
    'Responda *sim* para apagar ou *não* para cancelar.'
  ].join('\n'));
}

export async function handleCashPendingDeletion(context: VerticalContext): Promise<VerticalResult | undefined> {
  const pending = await getPending(context.company.id, context.message.phone);
  if (!pending) return undefined;

  if (isCashDeletionCancellation(context.combinedText)) {
    await clearPending(context.company.id, context.message.phone);
    return text('Tudo bem 👍 Não apaguei nenhum registro.');
  }

  if (isCashDeletionConfirmation(context.combinedText)) {
    const deleted = await deletePending(context.company.id, pending);
    await clearPending(context.company.id, context.message.phone);
    return text(deleted === 1
      ? '🗑️ Confirmado! 1 registro apagado.'
      : `🗑️ Confirmado! ${deleted} registros apagados.`);
  }

  return text([
    `Tenho uma exclusão de ${pending.expectedCount} registro${pending.expectedCount === 1 ? '' : 's'} aguardando sua confirmação.`,
    'Responda *sim* para apagar ou *não* para cancelar.'
  ].join('\n'));
}
