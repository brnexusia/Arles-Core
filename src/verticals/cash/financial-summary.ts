import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import {
  type CashAggregateIntent,
  parseCashAggregateIntent
} from './aggregate-intent.js';
import {
  brazilParts,
  currentMonthWindow,
  currentWeekWindow,
  dateIsoOffset,
  isoBrazil,
  previousMonthWindow,
  previousWeekWindow
} from './time.js';

type SummaryWindow = {
  from: string;
  to: string;
  label: string;
} | null;

type SummaryRow = {
  count: number;
  income_count: number;
  expense_count: number;
  income: number;
  expense: number;
};

const MONTHS: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  março: 3,
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

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function parseBrazilDate(value: string, fallbackYear: number): string | null {
  const match = value.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
  if (!match?.[1] || !match[2]) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = match[3];
  const year = rawYear ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear) : fallbackYear;
  return validDate(year, month, day) ? iso(year, month, day) : null;
}

function resolveWindow(intent: CashAggregateIntent): SummaryWindow {
  if (intent.scope === 'all_time') return null;

  const period = intent.periodCanonical || 'hoje';
  const now = brazilParts();

  if (period === 'hoje') {
    const day = isoBrazil();
    return { from: day, to: day, label: 'hoje' };
  }
  if (period === 'ontem') {
    const day = dateIsoOffset(-1);
    return { from: day, to: day, label: 'ontem' };
  }
  if (period === 'anteontem') {
    const day = dateIsoOffset(-2);
    return { from: day, to: day, label: 'anteontem' };
  }
  if (period === 'esta semana') return { ...currentWeekWindow(), label: 'esta semana' };
  if (period === 'semana passada') return { ...previousWeekWindow(), label: 'semana passada' };
  if (period === 'este mês') return { ...currentMonthWindow(), label: 'este mês' };
  if (period === 'mês passado') return { ...previousMonthWindow(), label: 'mês passado' };
  if (period === 'este ano') return { from: iso(now.year, 1, 1), to: isoBrazil(), label: 'este ano' };
  if (period === 'ano passado') return { from: iso(now.year - 1, 1, 1), to: iso(now.year - 1, 12, 31), label: 'ano passado' };

  const lastDays = period.match(/^últimos\s+(\d{1,3})\s+dias$/i);
  if (lastDays?.[1]) {
    const days = Math.max(1, Math.min(366, Number(lastDays[1])));
    return { from: dateIsoOffset(-(days - 1)), to: isoBrazil(), label: `últimos ${days} dias` };
  }

  const month = period.match(/^(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+(20\d{2}))?$/i);
  if (month?.[1]) {
    const monthNumber = MONTHS[month[1].toLowerCase()]!;
    const year = month[2] ? Number(month[2]) : now.year;
    const lastDay = year === now.year && monthNumber === now.month ? now.day : daysInMonth(year, monthNumber);
    const label = `${month[1].toLowerCase()}${year !== now.year ? ` de ${year}` : ''}`;
    return { from: iso(year, monthNumber, 1), to: iso(year, monthNumber, lastDay), label };
  }

  const range = period.match(/^de\s+(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\s+a\s+(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)$/i);
  if (range?.[1] && range[2]) {
    const from = parseBrazilDate(range[1], now.year);
    const to = parseBrazilDate(range[2], now.year);
    if (from && to) return from <= to
      ? { from, to, label: period }
      : { from: to, to: from, label: period };
  }

  const date = parseBrazilDate(period, now.year);
  if (date) return { from: date, to: date, label: period };

  const today = isoBrazil();
  return { from: today, to: today, label: 'hoje' };
}

async function readSummary(companyId: string, window: SummaryWindow): Promise<SummaryRow> {
  const params: unknown[] = [companyId];
  let rangeSql = '';
  if (window) {
    rangeSql = 'and transaction_date between $2::date and $3::date';
    params.push(window.from, window.to);
  }

  const result = await db.query<SummaryRow>(
    `select
       count(*)::int as count,
       count(*) filter(where type='income')::int as income_count,
       count(*) filter(where type='expense')::int as expense_count,
       coalesce(sum(amount) filter(where type='income'),0)::float8 as income,
       coalesce(sum(amount) filter(where type='expense'),0)::float8 as expense
     from cash_transactions
     where company_id=$1 ${rangeSql}`,
    params
  );

  const row = result.rows[0];
  return {
    count: Number(row?.count ?? 0),
    income_count: Number(row?.income_count ?? 0),
    expense_count: Number(row?.expense_count ?? 0),
    income: Number(row?.income ?? 0),
    expense: Number(row?.expense ?? 0)
  };
}

function formatSummary(intent: CashAggregateIntent, row: SummaryRow, window: SummaryWindow): string {
  const label = window?.label ?? 'todo o histórico';

  if (intent.flow === 'income') {
    return [
      `💰 *Entradas — ${label}*`,
      `Total recebido: *${brl(row.income)}*`,
      `${row.income_count} lançamento${row.income_count === 1 ? '' : 's'} de entrada.`
    ].join('\n');
  }

  if (intent.flow === 'expense') {
    return [
      `💸 *Saídas — ${label}*`,
      `Total gasto: *${brl(row.expense)}*`,
      `${row.expense_count} lançamento${row.expense_count === 1 ? '' : 's'} de saída.`
    ].join('\n');
  }

  return [
    `📊 *Resumo financeiro — ${label}*`,
    `💰 Entradas: *${brl(row.income)}*`,
    `💸 Saídas: *${brl(row.expense)}*`,
    `🏦 Saldo: *${brl(row.income - row.expense)}*`,
    `📋 ${row.count} lançamento${row.count === 1 ? '' : 's'}`
  ].join('\n');
}

/** Executa um intent já tipado, sem reinterpretar a frase original. */
export async function executeCashFinancialSummary(
  context: VerticalContext,
  intent: CashAggregateIntent
): Promise<VerticalResult> {
  const window = resolveWindow(intent);
  const summary = await readSummary(context.company.id, window);
  return text(formatSummary(intent, summary, window));
}

/** Compatibilidade para chamadores legados baseados em texto. */
export async function handleCashFinancialSummary(context: VerticalContext): Promise<VerticalResult | null> {
  const intent = parseCashAggregateIntent(context.combinedText);
  return intent ? await executeCashFinancialSummary(context, intent) : null;
}
