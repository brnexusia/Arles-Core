import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import {
  cashPocketService,
  handleCashPocketCommand,
  parseCashPocketCommand,
  parseCashPocketCreateNames,
  type CashPocket
} from './cofrinhos.js';
import { normalizeCashText } from './management.js';

const POCKET_CONTEXT_TTL_SECONDS = 30 * 60;

type PocketContext = {
  ids: string[];
  names: string[];
};

export type CashPocketDeleteReference =
  | { kind: 'explicit' }
  | { kind: 'context' }
  | null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
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

export function parseCashPocketDeleteReference(input: string): CashPocketDeleteReference {
  const value = normalizeCashText(input);
  if (!hasDeleteVerb(value)) return null;

  if (/\bcofrinh(?:o|os)\b/.test(value)) return { kind: 'explicit' };

  // Referência curta só vale como contexto de cofrinho quando a mensagem inteira é
  // essencialmente “apaga ele/esse/isso”. Isso evita roubar exclusões financeiras
  // mais específicas, como “apaga ele porque registrei o mercado errado”.
  if (/^(?:por favor\s+)?(?:apag|exclu|remov|delet|retir|tir)\w*\s+(?:ele|ela|esse|essa|isso|este|esta)(?:\s+(?:ai|aí|pfv|por favor|pra mim|para mim))*[!.? ]*$/.test(value)) {
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

async function deletePocket(context: VerticalContext, pocket: CashPocket): Promise<VerticalResult> {
  const kept = await removePocketKeepingMoney(context.company.id, pocket);
  await clearPocketContext(context.company.id, context.message.phone);

  const lines = [`🐷 Cofrinho *${pocket.name}* apagado.`];
  if (kept.transactions > 0) {
    lines.push(`Seus ${kept.transactions} lançamento${kept.transactions === 1 ? '' : 's'} foram mantidos no saldo geral.`);
  }
  if (kept.forecasts > 0) {
    lines.push(`${kept.forecasts} previsão${kept.forecasts === 1 ? '' : 'ões'} também ${kept.forecasts === 1 ? 'foi mantida' : 'foram mantidas'} sem cofrinho.`);
  }
  if (!kept.transactions && !kept.forecasts) {
    lines.push('Nenhum lançamento financeiro foi apagado.');
  }
  return text(lines.join('\n'));
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
  const deletion = parseCashPocketDeleteReference(context.combinedText);
  if (deletion?.kind === 'explicit') {
    const mentioned = await cashPocketService.findMentioned(context.company.id, context.combinedText);
    if (mentioned.pocket) return await deletePocket(context, mentioned.pocket);
    if (mentioned.requestedName) {
      return text(`Não encontrei o cofrinho *${mentioned.requestedName}*. Mande “meus cofrinhos” para conferir os nomes.`);
    }
    return text('Qual cofrinho você quer apagar? Mande, por exemplo: “apaga o cofrinho Viagem”.');
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
    // Sem contexto recente de cofrinho, não intercepta: deixa a camada de registros
    // decidir se “apaga ele” se refere ao último lançamento financeiro.
  }

  const result = await handleCashPocketCommand(context);
  if (result) await rememberContextFromPocketCommand(context);
  return result;
}
