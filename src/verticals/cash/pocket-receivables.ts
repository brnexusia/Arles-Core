import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPocketService, type CashPocket } from './cofrinhos.js';
import { normalizeCashPocketLanguage } from './pocket-language.js';

export type CashPocketReceivableIntent =
  | { kind: 'create'; amount: number; debtor: string | null }
  | { kind: 'list' }
  | { kind: 'cancel'; amount: number | null }
  | null;

type PendingReceivable = {
  id: string;
  pocket_id: string;
  pocket_name: string;
  amount: number;
  description: string | null;
  debtor: string | null;
  due_date: string | null;
  created_at: string | Date;
};

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function money(raw: string): number | null {
  const value = String(raw ?? '').trim();
  const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(value)
    ? value.replace(/\./g, '').replace(',', '.')
    : value.replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function amountFrom(input: string): number | null {
  const matches = [...String(input ?? '').matchAll(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi)];
  for (const match of matches) {
    const amount = money(match[1] ?? '');
    if (amount != null) return amount;
  }
  return null;
}

function hasReceivableLanguage(value: string): boolean {
  return /\b(falta\s+cobrar|faltam\s+cobrar|tenho\s+que\s+cobrar|preciso\s+cobrar|a\s+receber|por\s+receber|me\s+deve|me\s+devem|esta\s+devendo|estao\s+devendo|ficou\s+devendo|ficaram\s+devendo|valor\s+pendente|recebimento\s+pendente)\b/.test(value);
}

function realizedIncome(value: string): boolean {
  return /\b(ja\s+recebi|recebi|entrou|caiu|depositaram|me\s+pagou|me\s+pagaram|foi\s+pago|foi\s+recebido)\b/.test(value);
}

function queryLanguage(value: string): boolean {
  return /\b(quanto|quais|qual|lista|listar|mostra|mostrar|o\s+que|pendencias?|pendente)\b/.test(value);
}

function cancelLanguage(value: string): boolean {
  return /\b(cancela|cancelar|cancele|apaga|apagar|remove|remover|exclui|excluir|desconsidera|nao\s+precisa\s+mais\s+cobrar)\b/.test(value);
}

function debtorFrom(input: string): string | null {
  const source = String(input ?? '');
  const patterns = [
    /\b(?:cobrar|a receber|por receber)\s+(?:r\$\s*)?\d+(?:[.,]\d{1,2})?\s+de\s+([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ' -]{1,60})(?=$|[,.;!?])/i,
    /\b([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ' -]{1,60})\s+(?:me deve|ficou devendo)\b/i
  ];
  for (const pattern of patterns) {
    const raw = source.match(pattern)?.[1]?.trim();
    if (!raw || /^(para|pra|pro|fechar|o|a)$/i.test(raw)) continue;
    return raw.replace(/\s+/g, ' ').slice(0, 80);
  }
  return null;
}

export function parseCashPocketReceivableIntent(input: string): CashPocketReceivableIntent {
  const canonical = normalizeCashPocketLanguage(input);
  const value = normalize(canonical);
  if (!value || !hasReceivableLanguage(value)) return null;

  const amount = amountFrom(canonical);
  if (cancelLanguage(value)) return { kind: 'cancel', amount };

  const looksQuestion = queryLanguage(value) && (/[?]$/.test(String(input).trim()) || !amount);
  if (looksQuestion) return { kind: 'list' };

  if (realizedIncome(value)) return null;
  if (!/\bcofrinh(?:o|os)\b/.test(value)) {
    return queryLanguage(value) ? { kind: 'list' } : null;
  }
  if (!amount) return null;
  return { kind: 'create', amount, debtor: debtorFrom(canonical) };
}

function explicitPocketName(input: string): string | null {
  const canonical = normalizeCashPocketLanguage(input);
  const match = canonical.match(/\b(?:no|na|do|da|de|para\s+o|pro|pra|ao)\s+cofrinho\s+(?:chamad[oa]\s+)?([^,.;!?]+?)(?=\s+(?:tenho|falta|faltam|preciso|a\s+receber|por\s+receber|me\s+deve|me\s+devem|esta\s+devendo|valor\s+pendente|recebimento\s+pendente)\b|$)/i);
  const name = String(match?.[1] ?? '').trim().replace(/\s+/g, ' ');
  return name && name.length <= 80 ? name : null;
}

async function resolvePocket(context: VerticalContext, required = true): Promise<{ pocket: CashPocket | null; error: string | null }> {
  const canonical = normalizeCashPocketLanguage(context.combinedText);
  const mentioned = await cashPocketService.findMentioned(context.company.id, canonical);
  if (mentioned.pocket) return { pocket: mentioned.pocket, error: null };

  const explicitName = mentioned.requestedName ?? explicitPocketName(canonical);
  if (explicitName) {
    const pocket = await cashPocketService.findByName(context.company.id, explicitName);
    if (pocket) return { pocket, error: null };
    return {
      pocket: null,
      error: `Não encontrei o cofrinho *${explicitName}*. Mande “meus cofrinhos” para conferir os nomes ou crie com “criar cofrinho ${explicitName}”.`
    };
  }

  if (!required) return { pocket: null, error: null };
  const pockets = await cashPocketService.list(context.company.id);
  if (pockets.length === 1) return { pocket: pockets[0]!, error: null };
  if (!pockets.length) return { pocket: null, error: 'Você ainda não tem cofrinhos. Crie um primeiro para guardar essa pendência.' };
  return {
    pocket: null,
    error: ['Em qual cofrinho esse valor a receber deve ficar?', ...pockets.map(item => `• ${item.name}`), '', 'Exemplo: “falta cobrar 110 no cofrinho Vendas”.'].join('\n')
  };
}

async function createReceivable(context: VerticalContext, pocket: CashPocket, amount: number, debtor: string | null): Promise<void> {
  await db.query(
    `insert into cash_pocket_receivables(
       company_id,pocket_id,user_phone,amount,description,debtor,source_message_id,source_message
     ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      context.company.id,
      pocket.id,
      String(context.message.phone ?? '').replace(/\D/g, '').slice(0, 20) || null,
      amount,
      debtor ? `A receber de ${debtor}` : 'Valor a receber',
      debtor,
      context.message.messageId || null,
      context.combinedText.slice(0, 1000)
    ]
  );
}

async function pendingReceivables(companyId: string, pocketId?: string | null): Promise<PendingReceivable[]> {
  const result = await db.query(
    `select r.id::text,r.pocket_id::text,p.name as pocket_name,r.amount::float8,r.description,r.debtor,r.due_date,r.created_at
     from cash_pocket_receivables r
     join cash_pockets p on p.id=r.pocket_id
     where r.company_id=$1 and r.status='pending'
       and ($2::uuid is null or r.pocket_id=$2::uuid)
     order by r.due_date asc nulls last,r.created_at asc
     limit 50`,
    [companyId, pocketId ?? null]
  );
  return result.rows as PendingReceivable[];
}

async function cancelReceivable(companyId: string, pocketId: string | null, amount: number | null): Promise<PendingReceivable | null> {
  const rows = await db.query<PendingReceivable>(
    `select r.id::text,r.pocket_id::text,p.name as pocket_name,r.amount::float8,r.description,r.debtor,r.due_date,r.created_at
     from cash_pocket_receivables r
     join cash_pockets p on p.id=r.pocket_id
     where r.company_id=$1 and r.status='pending'
       and ($2::uuid is null or r.pocket_id=$2::uuid)
       and ($3::numeric is null or r.amount=$3::numeric)
     order by r.created_at desc
     limit 1`,
    [companyId, pocketId, amount]
  );
  const row = rows.rows[0];
  if (!row) return null;
  await db.query(
    `update cash_pocket_receivables set status='cancelled',updated_at=now()
     where company_id=$1 and id=$2`,
    [companyId, row.id]
  );
  return row;
}

function receivableListMessage(rows: PendingReceivable[], pocket?: CashPocket | null): string {
  if (!rows.length) {
    return pocket
      ? `🐷 O cofrinho *${pocket.name}* não tem valores pendentes a receber.`
      : 'Você não tem valores pendentes a receber nos cofrinhos.';
  }
  const total = Math.round(rows.reduce((sum, row) => sum + Number(row.amount), 0) * 100) / 100;
  return [
    pocket ? `🧾 *A receber — ${pocket.name}*` : '🧾 *Valores a receber*',
    `Total pendente: *${brl(total)}*`,
    '',
    ...rows.map((row, index) => {
      const who = row.debtor ? ` de ${row.debtor}` : '';
      const pocketLabel = pocket ? '' : ` · 🐷 ${row.pocket_name}`;
      return `${index + 1}. ${brl(Number(row.amount))}${who}${pocketLabel}`;
    }),
    '',
    'Esses valores ainda não entram no seu saldo. Quando receber, registre a entrada normalmente no mesmo cofrinho.'
  ].join('\n');
}

export async function handleCashPocketReceivable(context: VerticalContext): Promise<VerticalResult | null> {
  const intent = parseCashPocketReceivableIntent(context.combinedText);
  if (!intent) return null;

  if (intent.kind === 'create') {
    const resolved = await resolvePocket(context, true);
    if (!resolved.pocket) return text(resolved.error ?? 'Qual cofrinho você quer usar?');
    await createReceivable(context, resolved.pocket, intent.amount, intent.debtor);
    return text([
      '🧾 *Valor a receber registrado*',
      `🐷 Cofrinho: *${resolved.pocket.name}*`,
      `💰 Falta cobrar: *${brl(intent.amount)}*`,
      intent.debtor ? `👤 De: ${intent.debtor}` : '',
      '',
      'Isso não altera seu saldo enquanto o dinheiro não entrar.',
      `Quando receber, diga por exemplo: “recebi ${brl(intent.amount)} no cofrinho ${resolved.pocket.name}”.`
    ].filter(Boolean).join('\n'));
  }

  const resolved = await resolvePocket(context, false);
  if (resolved.error) return text(resolved.error);

  if (intent.kind === 'cancel') {
    const canceled = await cancelReceivable(context.company.id, resolved.pocket?.id ?? null, intent.amount);
    if (!canceled) return text('Não encontrei esse valor pendente a receber para cancelar.');
    return text(`✅ Pendência cancelada: ${brl(Number(canceled.amount))} no cofrinho *${canceled.pocket_name}*. O saldo real não foi alterado.`);
  }

  const rows = await pendingReceivables(context.company.id, resolved.pocket?.id ?? null);
  return text(receivableListMessage(rows, resolved.pocket));
}
