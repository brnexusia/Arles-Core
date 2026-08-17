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
  | { kind: 'statement'; name: string; type?: 'income' | 'expense' }
  | { kind: 'flow'; name: string; type: 'income' | 'expense' }
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

function addPocketName(target: string[], rawName: string): void {
  const name = cleanPocketDisplayName(rawName);
  if (!validPocketName(name)) return;
  const key = normalizeCashPocketName(name);
  if (target.some(item => normalizeCashPocketName(item) === key)) return;
  target.push(name);
}

/**
 * Extrai uma ou várias criações de cofrinho da mesma mensagem.
 *
 * A criação em lote precisa ser resolvida antes do parser de comando único,
 * porque frases como "cria X e outro chamado Y" não podem deixar o segundo
 * comando grudado no nome do primeiro cofrinho.
 */
export function parseCashPocketCreateNames(input: string): string[] {
  const original = String(input ?? '').trim();
  if (!original) return [];

  const value = normalized(original);
  const hasCreationVerb = /\b(cria|criar|crie|abre|abrir|faz|faca|faça|quero|novo|nova)\b/.test(value);
  const hasPocketWord = /\bcofrinh(?:o|os)\b/.test(value);
  if (!hasCreationVerb || !hasPocketWord) return [];

  // Separa continuidades inline antes de extrair os nomes. Isso cobre:
  // "criar cofrinho Casa e outro chamado Lazer".
  const prepared = original
    .replace(/\s+(?=(?:e\s+)?(?:cria(?:r|e)?\s+)?outro(?:\s+cofrinho)?\s+(?:chamad[oa]|de|s[oó])\b)/gi, '\n')
    .replace(/\s+(?=(?:e\s+)?cria(?:r|e)?\s+outro\s+cofrinho\b)/gi, '\n');

  const lines = prepared
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);

  const names: string[] = [];
  let creationContext = false;
  let plainListMode = false;

  for (const line of lines) {
    const pluralHeader = line.match(
      /^(?:e\s+)?(?:cria|criar|crie|abre|abrir|faz|faca|faça)\s+(?:os\s+)?cofrinhos?\s*:?[\s-]*(.*)$/i
    );
    if (pluralHeader) {
      creationContext = true;
      plainListMode = true;
      const tail = String(pluralHeader[1] ?? '').trim();
      if (tail) {
        for (const candidate of tail.split(/[,;]+/)) addPocketName(names, candidate);
      }
      continue;
    }

    const explicitPatterns = [
      /^(?:e\s+)?(?:cria|criar|crie|abre|abrir|faz|faca|faça)\s+(?:(?:um|outro|mais\s+um)\s+)?cofrinho\s+(?:chamad[oa]\s+|de\s+)?(.+)$/i,
      /^(?:e\s+)?(?:novo|nova)\s+cofrinho\s+(?:chamad[oa]\s+|de\s+)?(.+)$/i,
      /^(?:e\s+)?quero\s+(?:um\s+)?cofrinho\s+(?:chamad[oa]\s+|de\s+)?(.+)$/i
    ];

    let explicitName: string | null = null;
    for (const pattern of explicitPatterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        explicitName = match[1];
        break;
      }
    }
    if (explicitName) {
      creationContext = true;
      plainListMode = false;
      addPocketName(names, explicitName);
      continue;
    }

    if (creationContext) {
      const continuation = line.match(
        /^(?:e\s+)?(?:cria\s+)?(?:outro|mais\s+um)(?:\s+cofrinho)?\s+(?:(?:chamad[oa]|de|s[oó])\s+)?(.+)$/i
      );
      if (continuation?.[1]) {
        addPocketName(names, continuation[1]);
        continue;
      }

      if (plainListMode && !/[?:]$/.test(line) && !/\b(saldo|extrato|quanto|gastei|recebi|paguei|ganhei)\b/i.test(line)) {
        for (const candidate of line.split(/[,;]+/)) addPocketName(names, candidate);
      }
    }
  }

  return names;
}

function extractNameAfterCofrinho(original: string): string | null {
  const match = original.match(/\bcofrinh(?:o|os)\s+(?:chamad[oa]\s+|d[oa]\s+|de\s+)?([^\n,;.!?]+)$/i);
  let name = cleanPocketDisplayName(match?.[1] ?? '');
  name = name.replace(/\s+(?:hoje|ontem|esse mês|este mês|no mês|na semana|agora)$/i, '').trim();
  return validPocketName(name) ? name : null;
}

function namedPocket(input: string): string | null {
  return extractNameAfterCofrinho(input)
    ?? (() => {
      const before = input.match(/\bcofrinho\s+(.+?)(?:\s+(?:tem|tenho|saldo|quanto|disponivel|disponível|extrato|movimentações|movimentacoes|lançamentos|lancamentos|registros))\b/i)?.[1];
      const clean = cleanPocketDisplayName(before ?? '');
      return validPocketName(clean) ? clean : null;
    })();
}

export function parseCashPocketCommand(input: string): CashPocketCommand {
  const value = normalized(input);
  if (!value || !/\bcofrinh/.test(value)) return null;

  const movement = /\b(gastei|gasto|paguei|comprei|recebi|ganhei|entrou|vendi|faturei|guardei|reservei|separei)\b/.test(value);
  const question = /\b(quanto|qual|total|soma|me mostra|mostra|liste|lista|quais|extrato|historico|historico|registros|lancamentos|movimentacoes)\b/.test(value) || /\?$/.test(input.trim());

  const createNames = parseCashPocketCreateNames(input);
  if (createNames.length === 1) return { kind: 'create', name: createNames[0] };

  if (!movement && /\b(lista|listar|liste|mostra|mostrar|mostre|quais|meus|ver)\b/.test(value) && /\bcofrinhos\b/.test(value)) {
    return { kind: 'list' };
  }

  const name = namedPocket(input);
  if (!name) return null;

  if (question && /\b(quanto|total|soma)\b/.test(value) && /\b(gastei|gasto|gastos|despesa|despesas|saiu|saidas|saída|saídas|paguei)\b/.test(value)) {
    return { kind: 'flow', name, type: 'expense' };
  }
  if (question && /\b(quanto|total|soma)\b/.test(value) && /\b(recebi|receita|receitas|entrou|entradas|ganhei|ganhos|faturei)\b/.test(value)) {
    return { kind: 'flow', name, type: 'income' };
  }

  if (!movement && /\b(saldo|quanto tem|quanto tenho|valor|disponivel|disponível)\b/.test(value)) {
    return { kind: 'balance', name };
  }

  if (question && /\b(extrato|movimentacoes|movimentações|lancamentos|lançamentos|registros|historico|histórico|mostra|lista|liste)\b/.test(value)) {
    const type = /\b(gast|despes|said|pague)\w*/.test(value)
      ? 'expense'
      : /\b(receit|entrad|ganh|receb)\w*/.test(value)
        ? 'income'
        : undefined;
    return { kind: 'statement', name, type };
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

  async flowTotal(companyId: string, pocketId: string, type: 'income' | 'expense'): Promise<{ amount: number; count: number }> {
    const result = await db.query(
      `select coalesce(sum(amount),0)::float8 as amount,count(*)::int as count
       from cash_transactions
       where company_id=$1 and pocket_id=$2 and type=$3`,
      [companyId, pocketId, type]
    );
    return { amount: Number(result.rows[0]?.amount ?? 0), count: Number(result.rows[0]?.count ?? 0) };
  }

  async statement(companyId: string, pocketId: string, limit = 10, type?: 'income' | 'expense'): Promise<any[]> {
    const result = await db.query(
      `select id::text,type,amount::float8,category,merchant,description,transaction_date,created_at
       from cash_transactions
       where company_id=$1 and pocket_id=$2 and ($4::text is null or type=$4)
       order by transaction_date desc,created_at desc
       limit $3`,
      [companyId, pocketId, Math.max(1, Math.min(30, limit)), type ?? null]
    );
    return result.rows;
  }
}

export const cashPocketService = new CashPocketService();

function pocketLine(pocket: CashPocketBalance): string {
  return `🐷 *${pocket.name}* — ${brl(pocket.balance)} · ${pocket.count} lançamento${pocket.count === 1 ? '' : 's'}`;
}

export async function handleCashPocketCommand(context: VerticalContext): Promise<VerticalResult | null> {
  const createNames = parseCashPocketCreateNames(context.combinedText);
  if (createNames.length) {
    const created: string[] = [];
    const existing: string[] = [];

    for (const name of createNames) {
      const result = await cashPocketService.create(context.company.id, name);
      (result.created ? created : existing).push(result.pocket.name);
    }

    if (createNames.length === 1) {
      const name = created[0] ?? existing[0];
      return created.length
        ? text([`🐷 Cofrinho *${name}* criado.`, '', `Para usar: “recebi 500 no cofrinho ${name}” ou “gastei 30 do cofrinho ${name}”.`].join('\n'))
        : text(`🐷 O cofrinho *${name}* já existe. O saldo e os lançamentos dele continuam separados.`);
    }

    const lines = ['🐷 *Cofrinhos organizados*', ''];
    if (created.length) {
      lines.push(`✅ Criados (${created.length}):`);
      lines.push(...created.map(name => `• ${name}`));
    }
    if (existing.length) {
      if (created.length) lines.push('');
      lines.push(`↩️ Já existiam (${existing.length}):`);
      lines.push(...existing.map(name => `• ${name}`));
    }
    lines.push('', 'Agora você pode registrar entradas e saídas dizendo o nome do cofrinho.');
    return text(lines.join('\n'));
  }

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
    if (!pockets.length) return text('Você ainda não tem cofrinhos. Para criar um: “criar cofrinho Emprego”.');
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

  if (command.kind === 'flow') {
    const flow = await cashPocketService.flowTotal(context.company.id, pocket.id, command.type);
    const label = command.type === 'income' ? 'entrou' : 'saiu';
    return text(`🐷 No cofrinho *${pocket.name}*, ${label} *${brl(flow.amount)}* em ${flow.count} lançamento${flow.count === 1 ? '' : 's'}.`);
  }

  const rows = await cashPocketService.statement(context.company.id, pocket.id, 10, command.type);
  if (!rows.length) return text(`🐷 O cofrinho *${pocket.name}* ainda não tem ${command.type === 'income' ? 'entradas' : command.type === 'expense' ? 'saídas' : 'lançamentos'}.`);
  return text([
    `🐷 *Últimos ${command.type === 'income' ? 'recebimentos' : command.type === 'expense' ? 'gastos' : 'lançamentos'} — ${pocket.name}*`,
    '',
    ...rows.map((row, index) => {
      const icon = row.type === 'income' ? '💰' : '💸';
      const label = String(row.description ?? row.merchant ?? row.category ?? 'Lançamento').trim();
      return `${index + 1}. ${icon} ${label} — ${brl(Number(row.amount))}`;
    })
  ].join('\n'));
}
