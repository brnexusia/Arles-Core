import { db } from '../../infrastructure/db.js';
import type { VerticalResult } from '../vertical.js';
import type { CashQueryFilters } from './query.js';
import { formatBrazilDate } from './time.js';

type CashQueryResultRow = {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  merchant: string | null;
  description: string | null;
  transaction_date: string;
  created_at: string;
};

type CashQueryResult = {
  rows: CashQueryResultRow[];
  count: number;
  income: number;
  expense: number;
  truncated: boolean;
};

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function searchExpression(): string {
  return `translate(lower(concat_ws(' ',coalesce(merchant,''),coalesce(description,''),coalesce(category,''),coalesce(source_message,''))),
    'áàâãäéèêëíìîïóòôõöúùûüç',
    'aaaaaeeeeiiiiooooouuuuc')`;
}

async function readQuery(companyId: string, filters: CashQueryFilters): Promise<CashQueryResult> {
  const type = filters.type === 'all' ? null : filters.type;
  const term = filters.term ? normalize(filters.term) : null;
  const normalizedTerm = term?.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() || null;
  const sortSql = filters.sort === 'amount_desc'
    ? 'amount desc, transaction_date desc, created_at desc'
    : filters.sort === 'amount_asc'
      ? 'amount asc, transaction_date desc, created_at desc'
      : 'transaction_date desc, created_at desc';

  const where = `company_id=$1
    and transaction_date between $2::date and $3::date
    and ($4::text is null or type=$4)
    and ($5::text is null or category=$5)
    and ($6::numeric is null or amount >= $6::numeric)
    and ($7::numeric is null or amount <= $7::numeric)
    and ($8::text is null or ${searchExpression()} like '%' || $8 || '%')`;
  const params = [
    companyId,
    filters.from,
    filters.to,
    type,
    filters.category,
    filters.minAmount,
    filters.maxAmount,
    normalizedTerm
  ];

  const [totals, rows] = await Promise.all([
    db.query<{ count: number; income: number; expense: number }>(
      `select count(*)::int as count,
        coalesce(sum(amount) filter(where type='income'),0)::float8 as income,
        coalesce(sum(amount) filter(where type='expense'),0)::float8 as expense
       from cash_transactions where ${where}`,
      params
    ),
    db.query<CashQueryResultRow>(
      `select id::text,type,amount::float8,category,merchant,description,transaction_date,created_at
       from cash_transactions where ${where}
       order by ${sortSql}
       limit $9`,
      [...params, filters.limit]
    )
  ]);

  const total = totals.rows[0] ?? { count: 0, income: 0, expense: 0 };
  return {
    rows: rows.rows,
    count: Number(total.count),
    income: Number(total.income),
    expense: Number(total.expense),
    truncated: Number(total.count) > rows.rows.length
  };
}

const brl = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function rowDescription(row: CashQueryResultRow): string {
  const description = String(row.description ?? '').trim();
  const merchant = String(row.merchant ?? '').trim();
  if (description) return description;
  if (merchant) return merchant;
  return row.type === 'income' ? 'Receita' : 'Lançamento';
}

function compactResult(filters: CashQueryFilters, result: CashQueryResult): VerticalResult {
  if (!result.count) {
    return { actions: [{ type: 'text', text: `Não encontrei registros em ${filters.periodLabel}.` }] };
  }

  const lines = result.rows.map(row =>
    `• ${rowDescription(row)} — ${brl(Number(row.amount))} · ${formatBrazilDate(String(row.transaction_date))}`
  );
  const chunks: string[] = [];
  let current = `📋 ${filters.periodLabel.charAt(0).toUpperCase()}${filters.periodLabel.slice(1)}:`;
  for (const line of lines) {
    if ((current + '\n' + line).length > 3000) {
      chunks.push(current);
      current = line;
    } else {
      current += `\n${line}`;
    }
  }
  if (result.truncated) current += `\n\nMostrando ${result.rows.length} de ${result.count} registros.`;
  chunks.push(current);
  return { actions: chunks.map(value => ({ type: 'text' as const, text: value })) };
}

function header(filters: CashQueryFilters, result: CashQueryResult): string[] {
  const subject = filters.type === 'income' ? 'Receitas' : filters.type === 'expense' ? 'Gastos' : 'Movimentações';
  const filterParts = [filters.periodLabel];
  if (filters.term) filterParts.push(`“${filters.term}”`);
  if (filters.category) filterParts.push(filters.category);
  if (filters.minAmount != null) filterParts.push(`a partir de ${brl(filters.minAmount)}`);
  if (filters.maxAmount != null) filterParts.push(`até ${brl(filters.maxAmount)}`);

  const lines = [`🔎 ${subject} — ${filterParts.join(' · ')}`, ''];
  if (filters.type === 'expense') lines.push(`💸 Total: ${brl(result.expense)}`);
  else if (filters.type === 'income') lines.push(`💰 Total: ${brl(result.income)}`);
  else {
    lines.push(`💰 Entradas: ${brl(result.income)}`);
    lines.push(`💸 Saídas: ${brl(result.expense)}`);
    lines.push(`🏦 Saldo: ${brl(result.income - result.expense)}`);
  }
  lines.push(`📋 ${result.count} registro${result.count === 1 ? '' : 's'}`);
  return lines;
}

function formatResult(filters: CashQueryFilters, result: CashQueryResult): VerticalResult {
  if (filters.compact) return compactResult(filters, result);

  if (!result.count) {
    const subject = filters.type === 'income' ? 'receitas' : filters.type === 'expense' ? 'gastos' : 'registros';
    const term = filters.term ? ` com “${filters.term}”` : '';
    return { actions: [{ type: 'text', text: `Não encontrei ${subject}${term} em ${filters.periodLabel}.` }] };
  }

  const intro = header(filters, result);
  const recordLines = result.rows.map((row, index) => {
    const icon = row.type === 'income' ? '💰' : '💸';
    return `${index + 1}. ${icon} ${brl(Number(row.amount))} — ${rowDescription(row)} · ${formatBrazilDate(String(row.transaction_date))}`;
  });

  const chunks: string[] = [];
  let current = [...intro, '', 'Registros:'].join('\n');
  for (const line of recordLines) {
    if ((current + '\n' + line).length > 3000) {
      chunks.push(current);
      current = line;
    } else {
      current += `\n${line}`;
    }
  }
  if (result.truncated) current += `\n\nMostrando ${result.rows.length} de ${result.count} registros encontrados.`;
  chunks.push(current);
  return { actions: chunks.map(value => ({ type: 'text' as const, text: value })) };
}

/** Executa filtros já tipados pelo interpretador central. Não recebe linguagem natural. */
export async function executeCashQueryFilters(
  companyId: string,
  filters: CashQueryFilters
): Promise<VerticalResult> {
  return formatResult(filters, await readQuery(companyId, filters));
}
