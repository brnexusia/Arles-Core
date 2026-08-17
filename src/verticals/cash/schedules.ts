import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashPocketService } from './cofrinhos.js';
import { categoryFrom } from './parser.js';
import { brazilParts, dateIsoOffset, formatBrazilDate, isoBrazil } from './time.js';

export type CashForecastRecurrence = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export type CashForecastType = 'income' | 'expense';

export interface CashScheduledForecast {
  id: string;
  company_id: string;
  user_phone: string | null;
  type: CashForecastType;
  amount: number;
  category: string;
  description: string | null;
  pocket_id: string | null;
  pocket_name?: string | null;
  recurrence: CashForecastRecurrence;
  interval_count: number;
  day_of_week: number | null;
  day_of_month: number | null;
  month_of_year: number | null;
  start_date: string;
  end_date: string | null;
  active: boolean;
  source_message_id: string | null;
  source_message: string | null;
}

export interface CashScheduleDraft {
  type: CashForecastType;
  amount: number;
  category: string;
  description: string;
  recurrence: CashForecastRecurrence;
  intervalCount: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  monthOfYear: number | null;
  startDate: string;
  endDate: string | null;
}

export type CashScheduleCommand =
  | { kind: 'create'; draft: CashScheduleDraft }
  | { kind: 'list'; type: CashForecastType | 'all' }
  | { kind: 'cancel'; index: number | 'last' }
  | { kind: 'projection'; targetDate: string; metric: 'balance' | 'expense' | 'income' | 'summary' }
  | null;

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  'segunda feira': 1,
  terca: 2,
  'terca feira': 2,
  quarta: 3,
  'quarta feira': 3,
  quinta: 4,
  'quinta feira': 4,
  sexta: 5,
  'sexta feira': 5,
  sabado: 6
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
    .replace(/[“”"']/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function cleanPhone(value: string): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 20);
}

function money(raw: string): number | null {
  const clean = String(raw ?? '').trim();
  const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(clean)
    ? clean.replace(/\./g, '').replace(',', '.')
    : clean.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
}

function amountFromForecast(input: string): number | null {
  const matches = [...input.matchAll(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi)];
  if (!matches.length) return null;

  // Em “todo dia 10 pago 350”, o primeiro número é a data e o último é o dinheiro.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    const before = input.slice(Math.max(0, (match.index ?? 0) - 10), match.index ?? 0);
    const after = input.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 6);
    if (/[\/-]\s*$/.test(before) || /^\s*[\/-]\s*\d/.test(after)) continue;
    const value = money(match[1]!);
    if (value != null) return value;
  }
  return null;
}

function forecastType(input: string): CashForecastType | null {
  const value = normalize(input);
  if (/\b(recebo|receber|receberei|ganho|ganhar|ganharei|entra|entrar|cai|cair|salario|renda|freela|faturamento|comissao|pix recebido|deposito)\b/.test(value)) return 'income';
  if (/\b(gasto|gastar|gastarei|pago|pagar|pagarei|compro|comprar|cartao|fatura|conta|parcela|assinatura|aluguel|mensalidade|debito|sai|sair)\b/.test(value)) return 'expense';
  return null;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function parseIso(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function dayDiff(from: string, to: string): number {
  return Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / 86_400_000);
}

function addDaysIso(value: string, days: number): string {
  const date = parseIso(value);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function nextDayOfMonth(day: number, now = new Date()): string | null {
  if (day < 1 || day > 31) return null;
  const p = brazilParts(now);
  let year = p.year;
  let month = p.month;
  let actualDay = Math.min(day, daysInMonth(year, month));
  if (p.day > actualDay) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    actualDay = Math.min(day, daysInMonth(year, month));
  }
  return iso(year, month, actualDay);
}

function nextWeekday(target: number, now = new Date()): string {
  const p = brazilParts(now);
  const delta = (target - p.weekday + 7) % 7;
  return dateIsoOffset(delta, now);
}

function weekdayFrom(input: string): number | null {
  const value = normalize(input);
  for (const [name, weekday] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name.replace(' ', '\\s+')}\\b`).test(value)) return weekday;
  }
  return null;
}

function explicitFutureDate(input: string, now = new Date()): string | null {
  const value = normalize(input);
  if (/\bdepois de amanha\b/.test(value)) return dateIsoOffset(2, now);
  if (/\bamanha\b/.test(value)) return dateIsoOffset(1, now);

  const inDays = value.match(/\bdaqui a\s+(\d{1,3})\s+dias?\b/);
  if (inDays) return dateIsoOffset(Math.min(730, Math.max(1, Number(inDays[1]))), now);

  const full = input.match(/\b(?:dia\s+)?(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (full) {
    const p = brazilParts(now);
    const yearRaw = full[3];
    let year = yearRaw ? Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : p.year;
    const month = Number(full[2]);
    const day = Number(full[1]);
    if (!yearRaw && validDate(year, month, day) && iso(year, month, day) < isoBrazil(now)) year += 1;
    if (validDate(year, month, day)) return iso(year, month, day);
  }

  const dayOnly = value.match(/\b(?:no\s+)?dia\s+(\d{1,2})\b/);
  if (dayOnly) return nextDayOfMonth(Number(dayOnly[1]), now);
  return null;
}

function cleanDescription(input: string, amount: number, type: CashForecastType): string {
  let value = String(input ?? '').trim();
  value = value
    .replace(/\b(?:agende|agenda|agendar|programe|programa|programar|preveja|prever|deixa previsto|deixe previsto)\b/gi, ' ')
    .replace(/\b(?:todo|toda)\s+(?:mes|mês|semana|ano)\b/gi, ' ')
    .replace(/\b(?:todos os dias|todo dia|diariamente|semanalmente|mensalmente|anualmente)\b/gi, ' ')
    .replace(/\b(?:no\s+)?dia\s+\d{1,2}\b/gi, ' ')
    .replace(/\b(?:segunda|terça|terca|quarta|quinta|sexta|sábado|sabado)(?:-feira)?\b/gi, ' ')
    .replace(/\b(?:amanhã|amanha|depois de amanhã|depois de amanha)\b/gi, ' ')
    .replace(new RegExp(`(?:r\\$\\s*)?${String(amount).replace('.', '[.,]')}(?:\\s*reais?)?`, 'i'), ' ')
    .replace(type === 'income'
      ? /\b(?:eu\s+)?(?:vou\s+)?(?:recebo|receber|ganho|ganhar|entra|entrar|cai|cair)\b/gi
      : /\b(?:eu\s+)?(?:vou\s+)?(?:gasto|gastar|pago|pagar|compro|comprar|sai|sair)\b/gi, ' ')
    .replace(/\b(?:no valor de|valor de|por|de)\b/gi, ' ')
    .replace(/[,:;.!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (value || (type === 'income' ? 'Entrada prevista' : 'Saída prevista')).slice(0, 160);
}

function recurrenceFrom(input: string, now = new Date()): Omit<CashScheduleDraft, 'type' | 'amount' | 'category' | 'description'> | null {
  const value = normalize(input);
  const p = brazilParts(now);

  const yearly = value.match(/\b(?:todo|a cada)\s+ano\b/);
  if (yearly) {
    const full = input.match(/\b(\d{1,2})[\/-](\d{1,2})\b/);
    const month = full ? Number(full[2]) : p.month;
    const day = full ? Number(full[1]) : p.day;
    if (!validDate(p.year, month, day)) return null;
    let year = p.year;
    if (iso(year, month, day) < isoBrazil(now)) year += 1;
    return {
      recurrence: 'yearly', intervalCount: 1, dayOfWeek: null,
      dayOfMonth: day, monthOfYear: month, startDate: iso(year, month, day), endDate: null
    };
  }

  const monthlyDay = value.match(/\b(?:todo|a cada)\s+(?:mes|mês)\b.*?\bdia\s+(\d{1,2})\b/)
    ?? value.match(/\btodo\s+dia\s+(\d{1,2})\b/)
    ?? value.match(/\bmensalmente\b.*?\bdia\s+(\d{1,2})\b/);
  if (monthlyDay) {
    const day = Number(monthlyDay[1]);
    const startDate = nextDayOfMonth(day, now);
    if (!startDate) return null;
    return {
      recurrence: 'monthly', intervalCount: 1, dayOfWeek: null,
      dayOfMonth: day, monthOfYear: null, startDate, endDate: null
    };
  }

  const everyMonths = value.match(/\ba cada\s+(\d{1,2})\s+meses?\b/);
  if (everyMonths) {
    const interval = Math.min(24, Math.max(1, Number(everyMonths[1])));
    const day = Number(value.match(/\bdia\s+(\d{1,2})\b/)?.[1] ?? p.day);
    const startDate = nextDayOfMonth(day, now);
    if (!startDate) return null;
    return {
      recurrence: 'monthly', intervalCount: interval, dayOfWeek: null,
      dayOfMonth: day, monthOfYear: null, startDate, endDate: null
    };
  }

  const weekday = weekdayFrom(input);
  if (weekday != null && /\b(toda|todo|semanalmente|a cada semana)\b/.test(value)) {
    return {
      recurrence: 'weekly', intervalCount: 1, dayOfWeek: weekday,
      dayOfMonth: null, monthOfYear: null, startDate: nextWeekday(weekday, now), endDate: null
    };
  }

  const everyWeeks = value.match(/\ba cada\s+(\d{1,2})\s+semanas?\b/);
  if (everyWeeks) {
    const interval = Math.min(52, Math.max(1, Number(everyWeeks[1])));
    const target = weekday ?? p.weekday;
    return {
      recurrence: 'weekly', intervalCount: interval, dayOfWeek: target,
      dayOfMonth: null, monthOfYear: null, startDate: nextWeekday(target, now), endDate: null
    };
  }

  const everyDays = value.match(/\ba cada\s+(\d{1,3})\s+dias?\b/);
  if (everyDays) {
    return {
      recurrence: 'daily', intervalCount: Math.min(365, Math.max(1, Number(everyDays[1]))),
      dayOfWeek: null, dayOfMonth: null, monthOfYear: null, startDate: isoBrazil(now), endDate: null
    };
  }

  if (/\b(todos os dias|todo dia(?!\s+\d)|diariamente)\b/.test(value)) {
    return {
      recurrence: 'daily', intervalCount: 1, dayOfWeek: null,
      dayOfMonth: null, monthOfYear: null, startDate: isoBrazil(now), endDate: null
    };
  }

  const future = explicitFutureDate(input, now);
  if (future) {
    return {
      recurrence: 'once', intervalCount: 1, dayOfWeek: null,
      dayOfMonth: null, monthOfYear: null, startDate: future, endDate: future
    };
  }

  return null;
}

function targetDateForProjection(input: string, now = new Date()): string {
  const value = normalize(input);
  const p = brazilParts(now);

  const inDays = value.match(/\bdaqui a\s+(\d{1,3})\s+dias?\b/);
  if (inDays) return dateIsoOffset(Math.min(730, Math.max(1, Number(inDays[1]))), now);

  if (/\b(fim|final)\s+do\s+(?:proximo|próximo)\s+mes\b|\b(fim|final)\s+do\s+mes\s+que\s+vem\b/.test(value)) {
    let year = p.year;
    let month = p.month + 1;
    if (month > 12) { month = 1; year += 1; }
    return iso(year, month, daysInMonth(year, month));
  }

  if (/\b(fim|final)\s+do\s+ano\b/.test(value)) return iso(p.year, 12, 31);

  const explicit = explicitFutureDate(input, now);
  if (explicit) return explicit;

  return iso(p.year, p.month, daysInMonth(p.year, p.month));
}

function scheduleMetric(input: string): 'balance' | 'expense' | 'income' | 'summary' {
  const value = normalize(input);
  if (/\bquanto\s+(?:eu\s+)?vou\s+(?:gastar|pagar)|\btotal\s+(?:de\s+)?(?:gastos|despesas)\s+previst/.test(value)) return 'expense';
  if (/\bquanto\s+(?:eu\s+)?vou\s+(?:receber|ganhar)|\btotal\s+(?:de\s+)?(?:entradas|receitas)\s+previst/.test(value)) return 'income';
  if (/\b(resumo|projecao completa|previsao completa)\b/.test(value)) return 'summary';
  return 'balance';
}

export function parseCashScheduleCommand(input: string, now = new Date()): CashScheduleCommand {
  const value = normalize(input);
  if (!value) return null;

  const cancel = value.match(/\b(?:cancela|cancelar|apaga|apagar|remove|remover|exclui|excluir)\b.*?\b(?:agendamento|previsao|previsto|agenda)\b(?:\s+(\d{1,2})|\s+(?:ultimo|último))?/);
  if (cancel) {
    const index = cancel[1] ? Number(cancel[1]) : 'last';
    return { kind: 'cancel', index };
  }

  if (/\b(meus agendamentos|minha agenda financeira|o que tenho agendado|lista(?:r)? agendamentos|mostra(?:r)? agendamentos|previsoes futuras|previsões futuras|gastos previstos|despesas previstas|entradas previstas|receitas previstas|contas futuras)\b/.test(value)
    && !/\bquanto\b/.test(value)) {
    const type: CashForecastType | 'all' = /\b(gastos|despesas|contas)\b/.test(value)
      ? 'expense'
      : /\b(entradas|receitas)\b/.test(value)
        ? 'income'
        : 'all';
    return { kind: 'list', type };
  }

  const looksProjection = /\b(saldo projetado|projecao|projeção|previsao de saldo|previsão de saldo|quanto vou ter|quanto terei|quanto vai sobrar|quanto vou ficar|como fica meu saldo|depois das contas|apos as contas|após as contas|quanto vou gastar|quanto vou receber|quanto vou ganhar)\b/.test(value);
  if (looksProjection && !/\bse\s+eu\b/.test(value)) {
    return { kind: 'projection', targetDate: targetDateForProjection(input, now), metric: scheduleMetric(input) };
  }

  const type = forecastType(input);
  const amount = amountFromForecast(input);
  const recurrence = recurrenceFrom(input, now);
  const scheduleLanguage = /\b(agend|program|previst|previs|todo|toda|todos os dias|diariamente|semanalmente|mensalmente|anualmente|a cada|amanha|amanhã|daqui a|no dia|dia\s+\d+)\w*/.test(value);
  const asks = /\b(quanto|qual|como|quais|mostra|lista)\b/.test(value) && /\?$/.test(String(input).trim());

  if (type && amount && recurrence && scheduleLanguage && !asks) {
    return {
      kind: 'create',
      draft: {
        type,
        amount,
        category: categoryFrom(input, type),
        description: cleanDescription(input, amount, type),
        ...recurrence
      }
    };
  }

  return null;
}

function recurrenceLabel(row: CashScheduledForecast): string {
  if (row.recurrence === 'once') return `uma vez em ${formatBrazilDate(row.start_date)}`;
  if (row.recurrence === 'daily') return row.interval_count === 1 ? 'todos os dias' : `a cada ${row.interval_count} dias`;
  if (row.recurrence === 'weekly') return row.interval_count === 1 ? 'toda semana' : `a cada ${row.interval_count} semanas`;
  if (row.recurrence === 'monthly') return row.interval_count === 1
    ? `todo mês no dia ${row.day_of_month}`
    : `a cada ${row.interval_count} meses no dia ${row.day_of_month}`;
  return `todo ano em ${String(row.day_of_month ?? 1).padStart(2, '0')}/${String(row.month_of_year ?? 1).padStart(2, '0')}`;
}

function occursOn(row: CashScheduledForecast, dateIso: string): boolean {
  if (!row.active || dateIso < row.start_date || (row.end_date && dateIso > row.end_date)) return false;
  if (row.recurrence === 'once') return dateIso === row.start_date;

  const date = parseIso(dateIso);
  const start = parseIso(row.start_date);
  const diff = dayDiff(row.start_date, dateIso);
  if (diff < 0) return false;

  if (row.recurrence === 'daily') return diff % Math.max(1, row.interval_count) === 0;

  if (row.recurrence === 'weekly') {
    const weeks = Math.floor(diff / 7);
    return date.getUTCDay() === (row.day_of_week ?? start.getUTCDay())
      && weeks % Math.max(1, row.interval_count) === 0;
  }

  if (row.recurrence === 'monthly') {
    const months = (date.getUTCFullYear() - start.getUTCFullYear()) * 12 + (date.getUTCMonth() - start.getUTCMonth());
    if (months < 0 || months % Math.max(1, row.interval_count) !== 0) return false;
    const wanted = Math.min(row.day_of_month ?? start.getUTCDate(), daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1));
    return date.getUTCDate() === wanted;
  }

  const month = row.month_of_year ?? (start.getUTCMonth() + 1);
  const wantedDay = Math.min(row.day_of_month ?? start.getUTCDate(), daysInMonth(date.getUTCFullYear(), month));
  return date.getUTCMonth() + 1 === month && date.getUTCDate() === wantedDay;
}

export class CashScheduleService {
  async create(context: VerticalContext, draft: CashScheduleDraft, pocketId?: string | null): Promise<CashScheduledForecast> {
    const result = await db.query(
      `insert into cash_scheduled_forecasts(
         company_id,user_phone,type,amount,category,description,pocket_id,
         recurrence,interval_count,day_of_week,day_of_month,month_of_year,
         start_date,end_date,source_message_id,source_message
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning id::text,company_id::text,user_phone,type,amount::float8,category,description,
                 pocket_id::text,recurrence,interval_count,day_of_week,day_of_month,month_of_year,
                 start_date,end_date,active,source_message_id,source_message`,
      [
        context.company.id, cleanPhone(context.message.phone) || null, draft.type, draft.amount,
        draft.category, draft.description, pocketId ?? null, draft.recurrence, draft.intervalCount,
        draft.dayOfWeek, draft.dayOfMonth, draft.monthOfYear, draft.startDate, draft.endDate,
        context.message.messageId || null, context.combinedText.slice(0, 1000)
      ]
    );
    return result.rows[0] as CashScheduledForecast;
  }

  async list(companyId: string, phone: string, type: CashForecastType | 'all' = 'all', limit = 30): Promise<CashScheduledForecast[]> {
    const result = await db.query(
      `select f.id::text,f.company_id::text,f.user_phone,f.type,f.amount::float8,f.category,f.description,
              f.pocket_id::text,p.name as pocket_name,f.recurrence,f.interval_count,f.day_of_week,
              f.day_of_month,f.month_of_year,f.start_date,f.end_date,f.active,f.source_message_id,f.source_message
       from cash_scheduled_forecasts f
       left join cash_pockets p on p.id=f.pocket_id
       where f.company_id=$1 and f.active=true
         and ($2::text='' or f.user_phone=$2)
         and ($3::text='all' or f.type=$3)
       order by f.created_at desc
       limit $4`,
      [companyId, cleanPhone(phone), type, Math.max(1, Math.min(100, limit))]
    );
    return result.rows as CashScheduledForecast[];
  }

  async cancel(companyId: string, phone: string, index: number | 'last'): Promise<CashScheduledForecast | null> {
    const rows = await this.list(companyId, phone, 'all', 50);
    const row = index === 'last' ? rows[0] : rows[index - 1];
    if (!row) return null;
    await db.query(
      `update cash_scheduled_forecasts set active=false,updated_at=now() where company_id=$1 and id=$2`,
      [companyId, row.id]
    );
    return row;
  }

  async forecast(companyId: string, phone: string, fromIso: string, toIso: string): Promise<{
    income: number;
    expense: number;
    count: number;
    occurrences: Array<{ row: CashScheduledForecast; date: string }>;
  }> {
    const rows = await this.list(companyId, phone, 'all', 100);
    const occurrences: Array<{ row: CashScheduledForecast; date: string }> = [];
    const maxDays = Math.min(1095, Math.max(0, dayDiff(fromIso, toIso)));
    for (let offset = 0; offset <= maxDays; offset += 1) {
      const date = addDaysIso(fromIso, offset);
      for (const row of rows) {
        if (occursOn(row, date)) occurrences.push({ row, date });
      }
    }
    const income = occurrences.filter(item => item.row.type === 'income').reduce((sum, item) => sum + Number(item.row.amount), 0);
    const expense = occurrences.filter(item => item.row.type === 'expense').reduce((sum, item) => sum + Number(item.row.amount), 0);
    return {
      income: Math.round(income * 100) / 100,
      expense: Math.round(expense * 100) / 100,
      count: occurrences.length,
      occurrences
    };
  }
}

export const cashScheduleService = new CashScheduleService();

async function realBalance(companyId: string): Promise<number> {
  const result = await db.query(
    `select (coalesce(sum(amount) filter(where type='income'),0)-
             coalesce(sum(amount) filter(where type='expense'),0))::float8 as balance
     from cash_transactions where company_id=$1`,
    [companyId]
  );
  return Number(result.rows[0]?.balance ?? 0);
}

function listMessage(rows: CashScheduledForecast[]): string {
  if (!rows.length) return '📅 Você ainda não tem previsões/agendamentos ativos.';
  return [
    '📅 *Seus agendamentos financeiros*',
    '',
    ...rows.map((row, index) => {
      const icon = row.type === 'income' ? '💰' : '💸';
      const pocket = row.pocket_name ? ` · 🐷 ${row.pocket_name}` : '';
      return `${index + 1}. ${icon} ${row.description || row.category} — ${brl(Number(row.amount))} · ${recurrenceLabel(row)}${pocket}`;
    }),
    '',
    'Para cancelar: “cancela agendamento 2”.'
  ].join('\n');
}

export async function handleCashScheduleDeterministic(context: VerticalContext): Promise<VerticalResult | null> {
  const command = parseCashScheduleCommand(context.combinedText);
  if (!command) return null;

  if (command.kind === 'list') {
    return text(listMessage(await cashScheduleService.list(context.company.id, context.message.phone, command.type)));
  }

  if (command.kind === 'cancel') {
    const canceled = await cashScheduleService.cancel(context.company.id, context.message.phone, command.index);
    if (!canceled) return text('Não encontrei esse agendamento. Mande “meus agendamentos” para conferir a lista.');
    return text(`🗓️ Agendamento cancelado: ${canceled.description || canceled.category} — ${brl(Number(canceled.amount))}.\nIsso não altera nenhum lançamento que já tenha sido registrado.`);
  }

  if (command.kind === 'projection') {
    const from = isoBrazil();
    const [balance, forecast] = await Promise.all([
      realBalance(context.company.id),
      cashScheduleService.forecast(context.company.id, context.message.phone, from, command.targetDate)
    ]);
    const projected = Math.round((balance + forecast.income - forecast.expense) * 100) / 100;

    if (command.metric === 'expense') {
      return text([
        `📉 *Gastos previstos até ${formatBrazilDate(command.targetDate)}*`,
        `Saídas previstas: *${brl(forecast.expense)}*`,
        `${forecast.occurrences.filter(item => item.row.type === 'expense').length} ocorrência(s) prevista(s).`,
        '',
        'Isso é previsão; não registrei nenhuma despesa real.'
      ].join('\n'));
    }
    if (command.metric === 'income') {
      return text([
        `📈 *Entradas previstas até ${formatBrazilDate(command.targetDate)}*`,
        `Entradas previstas: *${brl(forecast.income)}*`,
        `${forecast.occurrences.filter(item => item.row.type === 'income').length} ocorrência(s) prevista(s).`,
        '',
        'Isso é previsão; não registrei nenhuma entrada real.'
      ].join('\n'));
    }

    return text([
      `🔮 *Projeção até ${formatBrazilDate(command.targetDate)}*`,
      `Saldo real agora: ${brl(balance)}`,
      `➕ Entradas previstas: ${brl(forecast.income)}`,
      `➖ Saídas previstas: ${brl(forecast.expense)}`,
      `Saldo projetado: *${brl(projected)}*`,
      '',
      'Previsões não viram lançamentos reais automaticamente.'
    ].join('\n'));
  }

  const pocketRef = await cashPocketService.findMentioned(context.company.id, context.combinedText);
  if (pocketRef.explicit && !pocketRef.pocket) {
    return text(`Não encontrei o cofrinho *${pocketRef.requestedName || 'informado'}*. Mande “meus cofrinhos” para conferir os nomes.`);
  }

  const created = await cashScheduleService.create(context, command.draft, pocketRef.pocket?.id ?? null);
  return text([
    '📅 *Previsão agendada!*',
    `${created.type === 'income' ? '💰 Entrada' : '💸 Saída'} prevista: *${brl(Number(created.amount))}*`,
    `📝 ${created.description || created.category}`,
    `🔁 ${recurrenceLabel(created)}`,
    pocketRef.pocket ? `🐷 Cofrinho: ${pocketRef.pocket.name}` : '',
    '',
    'Ela entra nas projeções, mas não altera seu saldo real até você registrar o movimento de verdade.'
  ].filter(Boolean).join('\n'));
}
