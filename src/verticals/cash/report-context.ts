import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { enrichCashFinancialReport, loadCashClosingPositions } from './report-position.js';
import { formatCashReport } from './reports.js';
import { cashService } from './service.js';
import {
  currentMonthWindow,
  currentWeekWindow,
  monthBeforeWindow,
  previousMonthWindow,
  previousWeekWindow
} from './time.js';

export type CashReportKind = 'weekly' | 'monthly';
export type CashReportPeriod = 'current' | 'previous';

export interface CashReportRequest {
  kind: CashReportKind;
  period: CashReportPeriod;
}

const REPORT_CONTEXT_TTL_SECONDS = 30 * 60;

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[!?.,]+$/g, '')
    .replace(/\s+/g, ' ');
}

function reportKey(companyId: string, phone: string): string {
  return `arles:cash:report:${companyId}:${String(phone ?? '').replace(/\D/g, '')}`;
}

function directKind(value: string): CashReportKind | null {
  const weekly = /\b(relatorio|resumo|fechamento)\b.*\b(semana|semanal)\b/.test(value)
    || /^como foi a semana(?: passada| atual)?$/.test(value)
    || /^(?:me manda|manda|mostra|me mostra|quero)\s+(?:o\s+)?(?:relatorio|resumo)\s+(?:da\s+)?(?:semana|semanal)/.test(value);
  if (weekly) return 'weekly';

  const monthly = /\b(relatorio|resumo|fechamento)\b.*\b(mes|mensal)\b/.test(value)
    || /^como foi o mes(?: passado| atual)?$/.test(value)
    || /^(?:me manda|manda|mostra|me mostra|quero)\s+(?:o\s+)?(?:relatorio|resumo)\s+(?:do\s+)?(?:mes|mensal)/.test(value);
  if (monthly) return 'monthly';

  return null;
}

function directPeriod(value: string, kind: CashReportKind): CashReportPeriod {
  if (kind === 'weekly') {
    return /\b(semana passada|ultima semana|semana anterior)\b/.test(value) ? 'previous' : 'current';
  }
  return /\b(mes passado|ultimo mes|mes anterior)\b/.test(value) ? 'previous' : 'current';
}

function temporalFollowup(value: string, lastKind: CashReportKind | null): CashReportRequest | null {
  if (lastKind === 'weekly') {
    if (/^(?:da|de|na)?\s*(?:semana passada|ultima semana|semana anterior)$/.test(value)) {
      return { kind: 'weekly', period: 'previous' };
    }
    if (/^(?:da|de|na)?\s*(?:essa semana|esta semana|dessa semana|desta semana|semana atual)$/.test(value)) {
      return { kind: 'weekly', period: 'current' };
    }
  }

  if (lastKind === 'monthly') {
    if (/^(?:do|de|no)?\s*(?:mes passado|ultimo mes|mes anterior)$/.test(value)) {
      return { kind: 'monthly', period: 'previous' };
    }
    if (/^(?:do|de|no)?\s*(?:esse mes|este mes|desse mes|deste mes|mes atual)$/.test(value)) {
      return { kind: 'monthly', period: 'current' };
    }
  }

  return null;
}

export function parseCashReportRequest(input: string, lastKind: CashReportKind | null = null): CashReportRequest | null {
  const value = normalize(input);
  if (!value) return null;

  const kind = directKind(value);
  if (kind) return { kind, period: directPeriod(value, kind) };

  return temporalFollowup(value, lastKind);
}

export function cashReportWindow(request: CashReportRequest, now = new Date()): { from: string; to: string } {
  if (request.kind === 'weekly') {
    return request.period === 'previous' ? previousWeekWindow(now) : currentWeekWindow(now);
  }
  return request.period === 'previous' ? previousMonthWindow(now) : currentMonthWindow(now);
}

async function getLastReportKind(companyId: string, phone: string): Promise<CashReportKind | null> {
  const value = await redis.get(reportKey(companyId, phone));
  return value === 'weekly' || value === 'monthly' ? value : null;
}

async function rememberReportKind(companyId: string, phone: string, kind: CashReportKind): Promise<void> {
  await redis.set(reportKey(companyId, phone), kind, 'EX', REPORT_CONTEXT_TTL_SECONDS);
}

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

export async function handleCashReportContext(context: VerticalContext): Promise<VerticalResult | null> {
  const direct = parseCashReportRequest(context.combinedText);
  const request = direct ?? parseCashReportRequest(
    context.combinedText,
    await getLastReportKind(context.company.id, context.message.phone)
  );
  if (!request) return null;

  const settings = await cashService.accessState(context.company.id);
  if (!settings.hasAccess) return null;

  const period = cashReportWindow(request);
  await rememberReportKind(context.company.id, context.message.phone, request.kind);

  if (request.kind === 'weekly') {
    const [summary, positions] = await Promise.all([
      cashService.summary(context.company.id, period.from, period.to),
      loadCashClosingPositions(context.company.id)
    ]);
    return text(enrichCashFinancialReport(formatCashReport({
      title: 'Relatório Semanal',
      from: period.from,
      to: period.to,
      summary,
      name: settings.owner_name
    }), positions));
  }

  const previousPeriod = monthBeforeWindow(period.from);
  const [summary, previous, positions] = await Promise.all([
    cashService.summary(context.company.id, period.from, period.to),
    cashService.summary(context.company.id, previousPeriod.from, previousPeriod.to),
    loadCashClosingPositions(context.company.id)
  ]);
  return text(enrichCashFinancialReport(formatCashReport({
    title: 'Relatório Mensal',
    from: period.from,
    to: period.to,
    summary,
    previous,
    name: settings.owner_name
  }), positions));
}
