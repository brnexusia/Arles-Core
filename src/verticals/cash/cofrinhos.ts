import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';

export interface CashPocket {
  id: string;
  company_id: string;
  name: string;
  normalized_name: string;
  active: boolean;
  created_at?: Date | string;
}

export interface CashPocketBalance extends CashPocket {
  income: number;
  expense: number;
  balance: number;
  count: number;
}

export type CashPocketCommand =
  | { kind: 'create'; name: string }
  | { kind: 'list' }
  | { kind: 'balance'; name: string }
  | { kind: 'statement'; name: string }
  | null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function normalizeCashPocketName(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 _-]+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function cleanPocketDisplayName(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^["'“”]+|["'“”.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function validPocketName(value: string): boolean {
  const clean = normalizeCashPocketName(value);
  if (clean.length < 2 || clean.length > 80) return false;
  return !/^(cofrinho|meu cofrinho|novo cofrinho|saldo|extrato|lista|listar|criar|crie)$/.test(clean);
}

function normalized(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function extractNameAfterCofrinho(original: string): string | null {
  const match = original.match(/\bcofrinh(?:o|os)\s+(?:chamad[oa]\s+|d[oa]\s+|de\s+)?([^\n,;.!?]+)$/i);
  const name = cleanPocketDisplayName(match?.[1] ?? '');
  return validPocketName(name) ? name : null;
}

export function parseCashPocketCommand(input: string): CashPocketCommand {
  const value = normalized(input);
  if (!value || !/\bcofrinh/.test(value)) return null;

  const movement = /\b(gastei|gasto|paguei|comprei|recebi|ganhei|entrou|vendi|faturei|guardei|reservei|separei)\b/.test(value);

  if (/\b(cria|criar|crie|novo|nova|abre|abrir|faz|faca|faça|quero)\b/.test(value) && /\bcofrinho\b/.test(value)) {
    const patterns = [
      /\b(?:cria|criar|crie|abre|abrir|faz|faça|faca)\s+(?:um\s+|o\s+)?cofrinho\s+(?:chamado\s+|chamada\s+|de\s+)?(.+)$/i,
      /\b(?:novo|nova)\s+cofrinho\s+(?:chamado\s+|chamada\s+|de\s+)?(.+)$/i,
      /\bquero\s+(?:um\s+)?cofrinho\s+(?:chamado\s+|chamada\s+|de\s+)?(.+)$/i
    ];
    for (const pattern of patterns) {
      const match = input.match(pattern);
      const name = cleanPocketDisplayName(match?.[1] ?? '');
      if (validPocketName(name)) return { kind: 'create', name };
    }
  }

  if (!movement && /\b(lista|listar|liste|mostra|mostrar|mostre|quais|meus|ver)\b/.test(value) && /\bcofrinhos\b/.test(value)) {
    return { kind: 'list' };
  }

  if (!movement && /\b(saldo|quanto|quanto tem|quanto tenho|valor|disponivel|disponível)\b/.test(value)) {
    const name = extractNameAfterCofrinho(input)
      ?? cleanPocketDisplayName(input.match(/\bcofrinho\s+(.+?)(?:\s+(?:tem|tenho|saldo|quanto|disponivel|disponível))\b/i)?.[1] ?? '');
    if (validPocketName(name)) return { kind: 'balance', name };
  }

  if (!movement && /\b(extrato|movimentacoes|movimentações|lancamentos|lançamentos|registros|historico|histórico)\b/.test(value)) {
    const name = extractNameAfterCofrinho(input)
      ?? cleanPocketDisplayName(input.match(/\bcofrinho\s+(.+?)(?:\s+(?:extrato|movimentacoes|movimentações|lancamentos|lançamentos|registros|historico|histórico))\b/i)?.[1] ?? '');
    if (validPocketName(name)) return { kind: 'statement', name };
  }

  return null;
}

export class CashPocketService {
  async list(companyId: string): Promise<CashPocketBalance[]> {
    const result = await db.query(
      `select p.id::text,p.company_id::text,p.name,p.normalized_name,p.active,p.created_at,
              coalesce(sum(t.amount) filter(where t.type='income'),0)::float8 as income,
              coalesce(sum(t.amount) filter(where t.type='expense'),0)::float8 as expense,
              (coalesce(sum(t.amount) filter(where t.type='income'),0)-
               coalesce(sum(t.amount) filter(where t.type='expense'),0))::float8 as balance,
              count(t.id)::int as count
       from cash_pockets p
       left join cash_transactions t on t.pocket_id=p.id and t.company_id=p.company_id
       where p.company_id=$1 and p.active=true
       group by p.id,p.company_id,p.name,p.normalized_name,p.active,p.created_at
       order by p.created_at asc,p.name asc`,
      [companyId]
    );
    return result.rows as CashPocketBalance[];
  }

  async create(companyId: string, name: string): Promise<{ pocket: CashPocket; created: boolean }> {
    const display = cleanPocketDisplayName(name);
    const normalizedName = normalizeCashPocketName(display);
    if (!validPocketName(display)) throw new Error('CASH_POCKET_NAME_INVALID');

    const existing = await db.query(
      `select id::text,company_id::text,name,normalized_name,active,created_at
       from cash_pockets where company_id=$1 and normalized_name=$2 limit 1`,
      [companyId, normalizedName]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].active !== true) {
        const restored = await db.query(
          `update cash_pockets set active=true,name=$3,updated_at=now()
           where company_id=$1 and normalized_name=$2
           returning id::text,company_id::text,name,normalized_name,active,created_at`,
          [companyId, normalizedName, display]
        );
        return { pocket: restored.rows[0] as CashPocket, created: true };
      }
      return { pocket: existing.rows[0] as CashPocket, created: false };
    }

    const result = await db.query(
      `insert into cash_pockets(company_id,name,normalized_name)
       values($1,$2,$3)
       returning id::text,company_id::text,name,normalized_name,active,created_at`,
      [companyId, display, normalizedName]
    );
    return { pocket: result.rows[0] as CashPocket, created: true };
  }

  async findByName(companyId: string, name: string): Promise<CashPocket | null> {
    const normalizedName = normalizeCashPocketName(name);
    if (!normalizedName) return null;
    const result = await db.query(
      `select id::text,company_id::text,name,normalized_name,active,created_at
       from cash_pockets
       where company_id=$1 and normalized_name=$2 and active=true
       limit 1`,
      [companyId, normalizedName]
    );
    return (result.rows[0] as CashPocket | undefined) ?? null;
  }

  async findMentioned(companyId: string, input: string): Promise<{ explicit: boolean; pocket: CashPocket | null; requestedName: string | null }> {
    const value = normalized(input);
    if (!/\bcofrinho\b/.test(value)) return { explicit: false, pocket: null, requestedName: null };

    const pockets = await this.list(companyId);
    const sorted = [...pockets].sort((a, b) => b.normalized_name.length - a.normalized_name.length);
    for (const pocket of sorted) {
      const candidates = [
        `cofrinho ${pocket.normalized_name}`,
        `cofrinho do ${pocket.normalized_name}`,
        `cofrinho da ${pocket.normalized_name}`,
        `cofrinho de ${pocket.normalized_name}`
      ];
      if (candidates.some(candidate => value.includes(candidate))) {
        return { explicit: true, pocket, requestedName: pocket.name };
      }
    }

    const free = extractNameAfterCofrinho(input);
    return { explicit: true, pocket: null, requestedName: free };
  }

  async balance(companyId: string, pocketId: string): Promise<{ income: number; expense: number; balance: number; count: number }> {
    const result = await db.query(
      `select
         coalesce(sum(amount) filter(where type='income'),0)::float8 as income,
         coalesce(sum(amount) filter(where type='expense'),0)::float8 as expense,
         (coalesce(sum(amount) filter(where type='income'),0)-
          coalesce(sum(amount) filter(where type='expense'),0))::float8 as balance,
         count(*)::int as count
       from cash_transactions
       where company_id=$1 and pocket_id=$2`,
      [companyId, pocketId]
    );
    return {
      income: Number(result.rows[0]?.income ?? 0),
      expense: Number(result.rows[0]?.expense ?? 0),
      balance: Number(result.rows[0]?.balance ?? 0),
      count: Number(result.rows[0]?.count ?? 0)
    };
  }

  async statement(companyId: string, pocketId: string, limit = 10): Promise<any[]> {
    const result = await db.query(
      `select id::text,type,amount::float8,category,merchant,description,transaction_date,created_at
       from cash_transactions
       where company_id=$1 and pocket_id=$2
       order by transaction_date desc,created_at desc
       limit $3`,
      [companyId, pocketId, Math.max(1, Math.min(30, limit))]
    );
    return result.rows;
  }
}

export const cashPocketService = new CashPocketService();

function pocketLine(pocket: CashPocketBalance): string {
  return `🐷 *${pocket.name}* — ${brl(pocket.balance)} · ${pocket.count} lançamento${pocket.count === 1 ? '' : 's'}`;
}

export async function handleCashPocketCommand(context: VerticalContext): Promise<VerticalResult | null> {
  const command = parseCashPocketCommand(context.combinedText);
  if (!command) return null;

  if (command.kind === 'create') {
    const result = await cashPocketService.create(context.company.id, command.name);
    return result.created
      ? text([`🐷 Cofrinho *${result.pocket.name}* criado.`, '', `Para usar: “recebi 500 no cofrinho ${result.pocket.name}” ou “gastei 30 do cofrinho ${result.pocket.name}”.`].join('\n'))
      : text(`🐷 O cofrinho *${result.pocket.name}* já existe. O saldo e os lançamentos dele continuam separados.`);
  }

  if (command.kind === 'list') {
    const pockets = await cashPocketService.list(context.company.id);
    if (!pockets.length) {
      return text('Você ainda não tem cofrinhos. Para criar um: “criar cofrinho Emprego”.');
    }
    return text(['🐷 *Seus cofrinhos*', '', ...pockets.map(pocketLine), '', 'Para ver um deles: “saldo do cofrinho Emprego”.'].join('\n'));
  }

  const pocket = await cashPocketService.findByName(context.company.id, command.name);
  if (!pocket) {
    return text(`Não encontrei o cofrinho *${command.name}*. Mande “meus cofrinhos” para ver os nomes ou “criar cofrinho ${command.name}”.`);
  }

  if (command.kind === 'balance') {
    const balance = await cashPocketService.balance(context.company.id, pocket.id);
    return text([
      `🐷 *${pocket.name}*`,
      `Disponível: *${brl(balance.balance)}*`,
      `Entradas: ${brl(balance.income)}`,
      `Saídas: ${brl(balance.expense)}`,
      `${balance.count} lançamento${balance.count === 1 ? '' : 's'} nesse cofrinho.`
    ].join('\n'));
  }

  const rows = await cashPocketService.statement(context.company.id, pocket.id, 10);
  if (!rows.length) return text(`🐷 O cofrinho *${pocket.name}* ainda não tem lançamentos.`);
  return text([
    `🐷 *Últimos lançamentos — ${pocket.name}*`,
    '',
    ...rows.map((row, index) => {
      const icon = row.type === 'income' ? '💰' : '💸';
      const label = String(row.description ?? row.merchant ?? row.category ?? 'Lançamento').trim();
      return `${index + 1}. ${icon} ${label} — ${brl(Number(row.amount))}`;
    })
  ].join('\n'));
}
