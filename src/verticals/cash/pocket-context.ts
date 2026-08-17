import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import {
  cashPocketService,
  handleCashPocketCommand,
  parseCashPocketCommand,
  parseCashPocketCreateNames,
  type CashPocket,
  type CashPocketBalance
} from './cofrinhos.js';
import { normalizeCashText } from './management.js';
import { handleCashReportContext } from './report-context.js';

const POCKET_CONTEXT_TTL_SECONDS = 30 * 60;

type PocketContext = {
  ids: string[];
  names: string[];
};

export type CashPocketDeleteReference =
  | { kind: 'explicit' }
  | { kind: 'context' }
  | { kind: 'context-all' }
  | null;

export type CashPocketBalanceReference =
  | { kind: 'explicit-all' }
  | { kind: 'context' }
  | null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function phoneDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function pocketContextKey(companyId: string, phone: string): string {
  return `arles:cash:pocket-context:${companyId}:${phoneDigits(phone)}`;
}

function hasDeleteVerb(value: string): boolean {
  return /\b(apag|exclu|remov|delet|retir|tir)\w*/.test(value);
}

function hasPocketCreationVerb(value: string): boolean {
  return /\b(cria|criar|crie|abre|abrir|faz|faca|faça|novo|nova)\b/.test(value);
}

export function normalizeCashPocketBatchInput(input: string): string {
  return String(input ?? '')
    .replace(
      /([.!?;])\s*(?=(?:e\s+)?(?:cria|criar|crie|abre|abrir|faz|faca|faça)\s+(?:(?:um|o|outro|mais\s+um)\s+)?cofrinho\b)/gi,
      '$1\n'
    )
    .replace(
      /\s+(?=(?:e\s+)?(?:cria|criar|crie|abre|abrir|faz|faca|faça)\s+(?:(?:um|o|outro|mais\s+um)\s+)?cofrinho\b)/gi,
      '\n'
    )
    .replace(
      /^((?:e\s+)?(?:cria|criar|crie|abre|abrir|faz|faca|faça))\s+cofrinho\b/gim,
      '$1 o cofrinho'
    );
}

export function parseCashPocketDeleteReference(input: string): CashPocketDeleteReference {
  const value = normalizeCashText(input);
  if (!hasDeleteVerb(value)) return null;

  if (/\bcofrinh(?:o|os)\b/.test(value)) return { kind: 'explicit' };

  if (/^(?:por favor\s+)?(?:apag|exclu|remov|delet|retir|tir)\w*\s+(?:eles|elas|esses|essas|estes|estas|todos(?:\s+eles)?|todas(?:\s+elas)?)(?:\s+(?:ai|aí|pfv|por favor|pra mim|para mim))*[!.? ]*$/.test(value)) {
    return { kind: 'context-all' };
  }

  if (/^(?:por favor\s+)?(?:apag|exclu|remov|delet|retir|tir)\w*\s+(?:ele|ela|esse|essa|isso|este|esta)(?:\s+(?:ai|aí|pfv|por favor|pra mim|para mim))*[!.? ]*$/.test(value)) {
    return { kind: 'context' };
  }

  return null;
}

export function parseCashPocketBalanceReference(input: string): CashPocketBalanceReference {
  const value = normalizeCashText(input).replace(/[!?.,]+$/g, '').trim();
  if (!value || hasDeleteVerb(value) || hasPocketCreationVerb(value)) return null;

  const balanceLanguage = /\b(saldo|quanto|total|tem|tenho|ficou|fica|guardado|guardei|disponivel|disponível|dinheiro)\b/.test(value);
  const pluralPocket = /\b(cofrinhos|caixinhas|envelopes|potinhos|potes)\b/.test(value);
  if (pluralPocket && balanceLanguage) return { kind: 'explicit-all' };

  if (/^(?:e\s+)?(?:no|nos|do|dos)?\s*cofrinh(?:o|os)$/.test(value)) {
    return { kind: 'context' };
  }

  if (/^(?:e\s+)?(?:quanto\s+(?:tem|tenho|ficou|fica)|qual(?:\s+e)?\s+(?:o\s+)?saldo|saldo|total)(?:\s+(?:nele|nela|neles|nelas|ali|la|lá))?$/.test(value)) {
    return { kind: 'context' };
  }

  if (/^(?:e\s+)?(?:nele|nela|neles|nelas)(?:\s+(?:quanto|qual|saldo|total))?$/.test(value)) {
    return { kind: 'context' };
  }

  return null;
}

async function savePocketContext(companyId: string, phone: string, pockets: CashPocket[]): Promise<void> {
  const unique = new Map<string, CashPocket>();
  for (const pocket of pockets) {
    if (pocket?.id && pocket.active !== false) unique.set(String(pocket.id), pocket);
  }

  const values = [...unique.values()];
  const key = pocketContextKey(companyId, phone);
  if (!values.length) {
    await redis.del(key);
    return;
  }

  const payload: PocketContext = {
    ids: values.map(pocket => String(pocket.id)),
    names: values.map(pocket => String(pocket.name))
  };
  await redis.set(key, JSON.stringify(payload), 'EX', POCKET_CONTEXT_TTL_SECONDS);
}

async function getPocketContext(companyId: string, phone: string): Promise<PocketContext | null> {
  const raw = await redis.get(pocketContextKey(companyId, phone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PocketContext;
    if (!Array.isArray(parsed.ids) || !Array.isArray(parsed.names) || !parsed.ids.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function clearPocketContext(companyId: string, phone: string): Promise<void> {
  await redis.del(pocketContextKey(companyId, phone));
}

async function activePocketById(companyId: string, pocketId: string): Promise<CashPocket | null> {
  const result = await db.query(
    `select id::text,company_id::text,name,normalized_name,active,created_at
     from cash_pockets
     where company_id=$1 and id::text=$2 and active=true
     limit 1`,
    [companyId, pocketId]
  );
  return (result.rows[0] as CashPocket | undefined) ?? null;
}

async function removePocketKeepingMoney(companyId: string, pocket: CashPocket): Promise<{ transactions: number; forecasts: number }> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const locked = await client.query(
      `select id from cash_pockets where company_id=$1 and id=$2 and active=true for update`,
      [companyId, pocket.id]
    );
    if (!locked.rowCount) {
      await client.query('rollback');
      return { transactions: 0, forecasts: 0 };
    }

    const transactions = await client.query(
      `update cash_transactions
       set pocket_id=null
       where company_id=$1 and pocket_id=$2
       returning id`,
      [companyId, pocket.id]
    );
    const forecasts = await client.query(
      `update cash_scheduled_forecasts
       set pocket_id=null,updated_at=now()
       where company_id=$1 and pocket_id=$2
       returning id`,
      [companyId, pocket.id]
    );
    await client.query(
      `update cash_pockets set active=false,updated_at=now()
       where company_id=$1 and id=$2`,
      [companyId, pocket.id]
    );
    await client.query('commit');

    return {
      transactions: Number(transactions.rowCount ?? 0),
      forecasts: Number(forecasts.rowCount ?? 0)
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function deletePockets(context: VerticalContext, pockets: CashPocket[]): Promise<VerticalResult> {
  let transactions = 0;
  let forecasts = 0;

  for (const pocket of pockets) {
    const kept = await removePocketKeepingMoney(context.company.id, pocket);
    transactions += kept.transactions;
    forecasts += kept.forecasts;
  }
  await clearPocketContext(context.company.id, context.message.phone);

  const lines = pockets.length === 1
    ? [`🐷 Cofrinho *${pockets[0]!.name}* apagado.`]
    : [
        `🐷 ${pockets.length} cofrinhos apagados:`,
        ...pockets.map(pocket => `• ${pocket.name}`)
      ];

  if (transactions > 0) {
    lines.push(`Seus ${transactions} lançamento${transactions === 1 ? '' : 's'} ${transactions === 1 ? 'foi mantido' : 'foram mantidos'} no saldo geral.`);
  }
  if (forecasts > 0) {
    lines.push(`${forecasts} previsão${forecasts === 1 ? '' : 'ões'} também ${forecasts === 1 ? 'foi mantida' : 'foram mantidas'} sem cofrinho.`);
  }

  return text(lines.join('\n'));
}

async function deletePocket(context: VerticalContext, pocket: CashPocket): Promise<VerticalResult> {
  return await deletePockets(context, [pocket]);
}

function pocketBalanceResult(pockets: CashPocketBalance[]): VerticalResult {
  if (pockets.length === 1) {
    const pocket = pockets[0]!;
    return text([
      `🐷 *${pocket.name}*`,
      `Saldo: *${brl(pocket.balance)}*`,
      `Entradas: ${brl(pocket.income)}`,
      `Saídas: ${brl(pocket.expense)}`,
      `${pocket.count} lançamento${pocket.count === 1 ? '' : 's'}.`
    ].join('\n'));
  }

  const total = pockets.reduce((sum, pocket) => sum + Number(pocket.balance), 0);
  const income = pockets.reduce((sum, pocket) => sum + Number(pocket.income), 0);
  const expense = pockets.reduce((sum, pocket) => sum + Number(pocket.expense), 0);

  return text([
    '🐷 *Seus cofrinhos*',
    `Total nos cofrinhos: *${brl(total)}*`,
    `Entradas: ${brl(income)}`,
    `Saídas: ${brl(expense)}`,
    '',
    ...pockets.map(pocket => `• ${pocket.name} — ${brl(pocket.balance)}`)
  ].join('\n'));
}

async function handlePocketBalanceReference(context: VerticalContext, reference: NonNullable<CashPocketBalanceReference>): Promise<VerticalResult | null> {
  const all = await cashPocketService.list(context.company.id);
  if (!all.length) return text('Você ainda não tem cofrinhos. Para criar um: “criar cofrinho Viagem”.');

  if (reference.kind === 'explicit-all') {
    await savePocketContext(context.company.id, context.message.phone, all);
    return pocketBalanceResult(all);
  }

  const remembered = await getPocketContext(context.company.id, context.message.phone);
  if (!remembered?.ids.length) return null;

  const wanted = new Set(remembered.ids.map(String));
  const selected = all.filter(pocket => wanted.has(String(pocket.id)));
  if (!selected.length) {
    await clearPocketContext(context.company.id, context.message.phone);
    return null;
  }

  return pocketBalanceResult(selected);
}

async function rememberContextFromPocketCommand(context: VerticalContext): Promise<void> {
  const createNames = parseCashPocketCreateNames(context.combinedText);
  if (createNames.length) {
    const pockets = (await Promise.all(createNames.map(name => cashPocketService.findByName(context.company.id, name))))
      .filter((pocket): pocket is CashPocket => Boolean(pocket));
    await savePocketContext(context.company.id, context.message.phone, pockets);
    return;
  }

  const command = parseCashPocketCommand(context.combinedText);
  if (!command) return;

  if (command.kind === 'list') {
    await savePocketContext(context.company.id, context.message.phone, await cashPocketService.list(context.company.id));
    return;
  }

  const pocket = await cashPocketService.findByName(context.company.id, command.name);
  if (pocket) await savePocketContext(context.company.id, context.message.phone, [pocket]);
}

export async function handleCashPocketContextCommand(context: VerticalContext): Promise<VerticalResult | null> {
  const report = await handleCashReportContext(context);
  if (report) return report;

  const deletion = parseCashPocketDeleteReference(context.combinedText);
  if (deletion?.kind === 'explicit') {
    const mentioned = await cashPocketService.findMentioned(context.company.id, context.combinedText);
    if (mentioned.pocket) return await deletePocket(context, mentioned.pocket);
    if (mentioned.requestedName) {
      return text(`Não encontrei o cofrinho *${mentioned.requestedName}*. Mande “meus cofrinhos” para conferir os nomes.`);
    }
    return text('Qual cofrinho você quer apagar? Mande, por exemplo: “apaga o cofrinho Viagem”.');
  }

  if (deletion?.kind === 'context-all') {
    const remembered = await getPocketContext(context.company.id, context.message.phone);
    if (remembered?.ids.length) {
      const pockets = (await Promise.all(
        remembered.ids.map(id => activePocketById(context.company.id, id))
      )).filter((pocket): pocket is CashPocket => Boolean(pocket));

      if (pockets.length) return await deletePockets(context, pockets);
      await clearPocketContext(context.company.id, context.message.phone);
    }
  }

  if (deletion?.kind === 'context') {
    const remembered = await getPocketContext(context.company.id, context.message.phone);
    if (remembered?.ids.length === 1) {
      const pocket = await activePocketById(context.company.id, remembered.ids[0]!);
      if (pocket) return await deletePocket(context, pocket);
      await clearPocketContext(context.company.id, context.message.phone);
    } else if (remembered && remembered.ids.length > 1) {
      return text([
        'Você acabou de ver mais de um cofrinho. Qual deles quer apagar?',
        ...remembered.names.map((name, index) => `${index + 1}. ${name}`),
        '',
        'Diga o nome, por exemplo: “apaga o cofrinho Viagem”.'
      ].join('\n'));
    }
  }

  const balanceReference = parseCashPocketBalanceReference(context.combinedText);
  if (balanceReference) {
    const balance = await handlePocketBalanceReference(context, balanceReference);
    if (balance) return balance;
  }

  const normalizedPocketText = normalizeCashPocketBatchInput(context.combinedText);
  const pocketContext = normalizedPocketText === context.combinedText
    ? context
    : { ...context, combinedText: normalizedPocketText };

  const result = await handleCashPocketCommand(pocketContext);
  if (result) await rememberContextFromPocketCommand(pocketContext);
  return result;
}
