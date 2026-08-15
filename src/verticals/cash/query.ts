import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { db } from '../../infrastructure/db.js';
import { env } from '../../config/env.js';
import type { VerticalResult } from '../vertical.js';
import {
  brazilParts,
  currentMonthWindow,
  currentWeekWindow,
  dateIsoOffset,
  formatBrazilDate,
  isoBrazil,
  previousMonthWindow,
  previousWeekWindow
} from './time.js';

const CATEGORIES = [
  'Alimentação',
  'Transporte',
  'Saúde',
  'Moradia',
  'Educação',
  'Pessoal',
  'Receita',
  'Outros'
] as const;

type CashQueryType = 'expense' | 'income' | 'all';
type CashQuerySort = 'recent' | 'amount_desc' | 'amount_asc';

export interface CashQueryFilters {
  type: CashQueryType;
  from: string;
  to: string;
  term: string | null;
  category: (typeof CATEGORIES)[number] | null;
  minAmount: number | null;
  maxAmount: number | null;
  sort: CashQuerySort;
  limit: number;
  periodLabel: string;
}

interface CashQueryResultRow {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  merchant: string | null;
  description: string | null;
  transaction_date: string;
  created_at: string;
}

interface CashQueryResult {
  rows: CashQueryResultRow[];
  count: number;
  income: number;
  expense: number;
  truncated: boolean;
}

const AiQuerySchema = z.object({
  is_query: z.boolean(),
  type: z.enum(['expense', 'income', 'all']),
  from: z.string().nullable(),
  to: z.string().nullable(),
  term: z.string().nullable(),
  category: z.enum(CATEGORIES).nullable(),
  min_amount: z.number().positive().nullable(),
  max_amount: z.number().positive().nullable(),
  sort: z.enum(['recent', 'amount_desc', 'amount_asc']),
  limit: z.number().int().min(1).max(100)
});

const MONTHS: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12
};

const CATEGORY_ALIASES: Array<[RegExp, (typeof CATEGORIES)[number]]> = [
  [/\balimentacao\b/, 'Alimentação'],
  [/\btransporte\b/, 'Transporte'],
  [/\bsaude\b/, 'Saúde'],
  [/\bmoradia\b/, 'Moradia'],
  [/\beducacao\b/, 'Educação'],
  [/\bpessoal\b/, 'Pessoal'],
  [/\breceita(?:s)?\b/, 'Receita'],
  [/\boutros\b/, 'Outros']
];

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function validIso(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function periodForMonth(year: number, month: number) {
  const now = brazilParts();
  const end = year === now.year && month === now.month
    ? now.day
    : daysInMonth(year, month);
  return { from: iso(year, month, 1), to: iso(year, month, end) };
}

function looksLikeQuery(text: string): boolean {
  const value = normalize(text);
  if (/\bquanto\s+(?:eu\s+)?(?:gastei|paguei|comprei|recebi|ganhei|entrou|saiu)\b/.test(value)) return true;
  if (/\b(?:o que|quais|mostra|mostrar|me mostra|liste|listar|lista|pesquisa|pesquisar|procura|procurar)\b/.test(value) &&
      /\b(gast|despes|compr|receit|entrada|saida|registro|registo|lancamento|moviment)\w*/.test(value)) return true;
  if (/\b(meus gastos|minhas despesas|minhas compras|minhas receitas|minhas entradas|meus recebimentos)\b/.test(value)) return true;
  if (/\b(maior(?:es)?|menor(?:es)?|mais caro|mais cara)\b.*\b(gast|despes|compr)\w*/.test(value)) return true;
  if (/^(gastos|despesas|compras|receitas|entradas|recebimentos)\b/.test(value)) return true;
  return false;
}

function typeFrom(text: string): CashQueryType {
  const value = normalize(text);
  if (/\b(recebi|receita|receitas|entrada|entradas|ganhei|recebimento|recebimentos|salario)\b/.test(value)) return 'income';
  if (/\b(gastei|gasto|gastos|despesa|despesas|comprei|compras|paguei|saidas?)\b/.test(value)) return 'expense';
  return 'all';
}

function explicitCategory(text: string): (typeof CATEGORIES)[number] | null {
  const value = normalize(text);
  for (const [pattern, category] of CATEGORY_ALIASES) {
    if (pattern.test(value)) return category;
  }
  return null;
}

function parsePeriod(text: string): { from: string; to: string; label: string; explicit: boolean } {
  const value = normalize(text);
  const now = brazilParts();

  if (/\banteontem\b/.test(value)) {
    const day = dateIsoOffset(-2);
    return { from: day, to: day, label: 'anteontem', explicit: true };
  }
  if (/\bontem\b/.test(value)) {
    const day = dateIsoOffset(-1);
    return { from: day, to: day, label: 'ontem', explicit: true };
  }
  if (/\bhoje\b/.test(value)) {
    const day = isoBrazil();
    return { from: day, to: day, label: 'hoje', explicit: true };
  }
  if (/\b(semana passada|ultima semana)\b/.test(value)) {
    const period = previousWeekWindow();
    return { ...period, label: 'semana passada', explicit: true };
  }
  if (/\b(esta semana|essa semana|semana atual)\b/.test(value)) {
    const period = currentWeekWindow();
    return { ...period, label: 'esta semana', explicit: true };
  }
  if (/\b(mes passado|ultimo mes)\b/.test(value)) {
    const period = previousMonthWindow();
    return { ...period, label: 'mês passado', explicit: true };
  }
  if (/\b(este mes|esse mes|mes atual)\b/.test(value)) {
    const period = currentMonthWindow();
    return { ...period, label: 'este mês', explicit: true };
  }
  if (/\b(este ano|esse ano|ano atual)\b/.test(value)) {
    return { from: iso(now.year, 1, 1), to: isoBrazil(), label: 'este ano', explicit: true };
  }
  if (/\b(ano passado|ultimo ano)\b/.test(value)) {
    return { from: iso(now.year - 1, 1, 1), to: iso(now.year - 1, 12, 31), label: 'ano passado', explicit: true };
  }

  const lastDays = value.match(/\bultimos?\s+(\d{1,3})\s+dias?\b/);
  if (lastDays) {
    const days = Math.min(366, Math.max(1, Number(lastDays[1])));
    return {
      from: dateIsoOffset(-(days - 1)),
      to: isoBrazil(),
      label: `últimos ${days} dias`,
      explicit: true
    };
  }

  const betweenDays = value.match(/\b(?:entre|do)\s+(?:o\s+)?dia\s*(\d{1,2})\s+(?:e|ate|ao)\s+(?:o\s+)?(?:dia\s*)?(\d{1,2})\b/);
  if (betweenDays) {
    const first = Number(betweenDays[1]);
    const last = Number(betweenDays[2]);
    const max = daysInMonth(now.year, now.month);
    if (first >= 1 && last >= first && last <= max) {
      return {
        from: iso(now.year, now.month, first),
        to: iso(now.year, now.month, last),
        label: `de ${String(first).padStart(2, '0')}/${String(now.month).padStart(2, '0')} a ${String(last).padStart(2, '0')}/${String(now.month).padStart(2, '0')}`,
        explicit: true
      };
    }
  }

  const fullRange = text.match(/\b(?:entre|de)\s+(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\s+(?:e|ate|a)\s+(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/i);
  if (fullRange) {
    const y1raw = fullRange[3];
    const y2raw = fullRange[6];
    const y1 = y1raw ? Number(y1raw.length === 2 ? `20${y1raw}` : y1raw) : now.year;
    const y2 = y2raw ? Number(y2raw.length === 2 ? `20${y2raw}` : y2raw) : y1;
    const from = iso(y1, Number(fullRange[2]), Number(fullRange[1]));
    const to = iso(y2, Number(fullRange[5]), Number(fullRange[4]));
    if (validIso(from) && validIso(to)) return { from, to, label: `${formatBrazilDate(from)} a ${formatBrazilDate(to)}`, explicit: true };
  }

  const fullDate = text.match(/\b(?:dia\s*)?(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (fullDate) {
    const yearRaw = fullDate[3];
    const year = yearRaw ? Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : now.year;
    const day = iso(year, Number(fullDate[2]), Number(fullDate[1]));
    if (validIso(day)) return { from: day, to: day, label: formatBrazilDate(day), explicit: true };
  }

  const monthMatch = value.match(new RegExp(`\\b(${Object.keys(MONTHS).join('|')})(?:\\s+de\\s+(\\d{4}))?\\b`));
  if (monthMatch) {
    const month = MONTHS[monthMatch[1]!]!;
    const year = monthMatch[2] ? Number(monthMatch[2]) : now.year;
    const period = periodForMonth(year, month);
    return { ...period, label: `${monthMatch[1]}${year !== now.year ? ` de ${year}` : ''}`, explicit: true };
  }

  const yearMatch = value.match(/\b(?:em|no ano de|ano)\s+(20\d{2})\b/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    return { from: iso(year, 1, 1), to: iso(year, 12, 31), label: `ano de ${year}`, explicit: true };
  }

  const dayOnly = value.match(/\bdia\s+(\d{1,2})\b/);
  if (dayOnly) {
    const dayNumber = Number(dayOnly[1]);
    if (dayNumber >= 1 && dayNumber <= daysInMonth(now.year, now.month)) {
      const day = iso(now.year, now.month, dayNumber);
      return { from: day, to: day, label: formatBrazilDate(day), explicit: true };
    }
  }

  const period = currentMonthWindow();
  return { ...period, label: 'este mês', explicit: false };
}

function amountFilters(text: string): { minAmount: number | null; maxAmount: number | null } {
  const value = normalize(text).replace(/\./g, '').replace(/,(\d{1,2})\b/g, '.$1');
  const money = '(\\d+(?:\\.\\d{1,2})?)';
  const between = value.match(new RegExp(`\\bentre\\s+${money}\\s+(?:e|ate)\\s+${money}(?:\\s+reais)?\\b`));
  if (between) return { minAmount: Number(between[1]), maxAmount: Number(between[2]) };

  const above = value.match(new RegExp(`\\b(?:acima de|mais de|maior que)\\s+(?:r\\$\\s*)?${money}`));
  const below = value.match(new RegExp(`\\b(?:abaixo de|menos de|menor que|ate)\\s+(?:r\\$\\s*)?${money}`));
  return {
    minAmount: above ? Number(above[1]) : null,
    maxAmount: below ? Number(below[1]) : null
  };
}

function sortFrom(text: string): { sort: CashQuerySort; limit: number } {
  const value = normalize(text);
  if (/\b(maior gasto|maior despesa|compra mais cara)\b/.test(value)) return { sort: 'amount_desc', limit: 1 };
  if (/\b(menor gasto|menor despesa|compra mais barata)\b/.test(value)) return { sort: 'amount_asc', limit: 1 };
  if (/\b(maiores|mais caros|mais caras)\b/.test(value)) return { sort: 'amount_desc', limit: 100 };
  if (/\b(menores|mais baratos|mais baratas)\b/.test(value)) return { sort: 'amount_asc', limit: 100 };
  return { sort: 'recent', limit: 100 };
}

function cleanupTerm(raw: string): string {
  return raw
    .replace(/\b(hoje|ontem|anteontem|agora|este mes|esse mes|mes atual|mes passado|ultimo mes|esta semana|essa semana|semana passada|este ano|esse ano|ano atual)\b.*$/i, '')
    .replace(/\b(?:acima de|mais de|maior que|abaixo de|menos de|menor que|entre)\b.*$/i, '')
    .replace(/[?!.]+$/g, '')
    .trim()
    .slice(0, 120);
}

function termFrom(text: string, category: string | null): string | null {
  const normalizedOriginal = text.trim();
  const patterns = [
    /\b(?:na|no|pela|pelo)\s+([^,?!.]+?)(?=\s+(?:hoje|ontem|anteontem|este|esse|esta|essa|mes|mês|semana|ano|acima|abaixo|mais de|menos de|entre|dia)\b|[?!.]|$)/i,
    /\b(?:com|de)\s+([^,?!.]+?)(?=\s+(?:hoje|ontem|anteontem|este|esse|esta|essa|mes|mês|semana|ano|acima|abaixo|mais de|menos de|entre|dia)\b|[?!.]|$)/i
  ];
  for (const pattern of patterns) {
    const match = normalizedOriginal.match(pattern);
    if (!match?.[1]) continue;
    const candidate = cleanupTerm(match[1]);
    if (!candidate) continue;
    if (category && normalize(candidate) === normalize(category)) return null;
    if (/^(gastos?|despesas?|compras?|receitas?|entradas?|saidas?)$/i.test(candidate)) continue;
    return candidate;
  }
  return null;
}

export function deterministicCashQuery(text: string): CashQueryFilters | null {
  if (!looksLikeQuery(text)) return null;
  const type = typeFrom(text);
  const period = parsePeriod(text);
  const category = explicitCategory(text);
  const amounts = amountFilters(text);
  const ordering = sortFrom(text);
  return {
    type,
    from: period.from,
    to: period.to,
    term: termFrom(text, category),
    category,
    minAmount: amounts.minAmount,
    maxAmount: amounts.maxAmount,
    sort: ordering.sort,
    limit: ordering.limit,
    periodLabel: period.label
  };
}

function canonicalAiFilters(parsed: z.infer<typeof AiQuerySchema>, fallback: CashQueryFilters | null): CashQueryFilters | null {
  if (!parsed.is_query) return fallback;
  const defaultPeriod = currentMonthWindow();
  const from = validIso(parsed.from) ? parsed.from : fallback?.from ?? defaultPeriod.from;
  const to = validIso(parsed.to) ? parsed.to : fallback?.to ?? defaultPeriod.to;
  return {
    type: parsed.type,
    from,
    to,
    term: parsed.term?.trim().slice(0, 120) || fallback?.term || null,
    category: parsed.category ?? fallback?.category ?? null,
    minAmount: parsed.min_amount ?? fallback?.minAmount ?? null,
    maxAmount: parsed.max_amount ?? fallback?.maxAmount ?? null,
    sort: parsed.sort,
    limit: Math.min(100, Math.max(1, parsed.limit)),
    periodLabel: fallback?.periodLabel ?? (from === defaultPeriod.from && to === defaultPeriod.to ? 'este mês' : `${formatBrazilDate(from)} a ${formatBrazilDate(to)}`)
  };
}

function searchExpression(): string {
  return `translate(lower(concat_ws(' ',coalesce(merchant,''),coalesce(description,''),coalesce(category,''),coalesce(source_message,''))),
    'áàâãäéèêëíìîïóòôõöúùûüç',
    'aaaaaeeeeiiiiooooouuuuc')`;
}

async function executeQuery(companyId: string, filters: CashQueryFilters): Promise<CashQueryResult> {
  const type = filters.type === 'all' ? null : filters.type;
  const term = filters.term ? normalize(filters.term) : null;
  const normalizedTerm = term?.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() || null;
  const category = filters.category;
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
    category,
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
  return row.category;
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
  if (!result.count) {
    const subject = filters.type === 'income' ? 'receitas' : filters.type === 'expense' ? 'gastos' : 'registros';
    const extra = filters.term ? ` com “${filters.term}”` : filters.category ? ` em ${filters.category}` : '';
    return { actions: [{ type: 'text', text: `Não encontrei ${subject}${extra} em ${filters.periodLabel}.` }] };
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

export class CashQueryEngine {
  private readonly client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

  async parse(text: string): Promise<CashQueryFilters | null> {
    const deterministic = deterministicCashQuery(text);
    if (!looksLikeQuery(text)) return null;
    if (!this.client) return deterministic;

    // Consultas simples e completas não precisam gastar IA.
    if (deterministic && (deterministic.term || deterministic.category || /\b(hoje|ontem|anteontem|semana|mes|mês|ano|dia)\b/i.test(text))) {
      return deterministic;
    }

    try {
      const currentMonth = currentMonthWindow();
      const response = await this.client.responses.parse({
        model: env.openaiModel,
        input: [
          {
            role: 'system',
            content: [
              'Você converte perguntas sobre histórico financeiro pessoal em filtros de busca. Não responda com valores; apenas extraia filtros.',
              'is_query=true apenas quando o usuário quer consultar gastos, receitas, compras, registros ou movimentações já salvos.',
              'type=expense para gastos/despesas/compras/pagamentos; income para receitas/entradas/recebimentos; all quando pedir movimentações gerais.',
              'term é loja, pessoa, produto ou descrição pesquisada, por exemplo SHEIN, mercado, salário, blusinha. Não use termos genéricos como gasto/despesa.',
              'category só pode ser uma das categorias fornecidas e deve ser usada quando o usuário citar a categoria explicitamente.',
              'Interprete datas no fuso America/Sao_Paulo e retorne from/to em YYYY-MM-DD.',
              `Hoje é ${isoBrazil()}. Se o usuário NÃO disser período, use o mês atual: ${currentMonth.from} a ${currentMonth.to}.`,
              'Para “maior gasto” use sort=amount_desc e limit=1; “menor gasto” amount_asc e limit=1; caso contrário recent e limit=100.',
              'Filtros de valor podem preencher min_amount e max_amount.',
              'Não invente filtros que não estejam implícitos na pergunta.'
            ].join('\n')
          },
          { role: 'user', content: text }
        ],
        text: { format: zodTextFormat(AiQuerySchema, 'cash_query') }
      });
      const parsed = response.output_parsed;
      if (!parsed) return deterministic;
      return canonicalAiFilters(parsed, deterministic);
    } catch (error) {
      console.error('[CashQuery] falha na IA:', error);
      return deterministic;
    }
  }

  async handle(companyId: string, text: string): Promise<VerticalResult | null> {
    const filters = await this.parse(text);
    if (!filters) return null;
    const result = await executeQuery(companyId, filters);
    return formatResult(filters, result);
  }
}

export const cashQuery = new CashQueryEngine();
