import { evolution } from '../../whatsapp/evolution.client.js';
import { env } from '../../config/env.js';
import { platformJobService } from '../../platform/jobs/job.service.js';
import type { ModuleJobContext } from '../../platform/modules/contract.js';
import { cashService } from './service.js';
import type { CashSummary } from './types.js';

const brl = (value: number) => value.toLocaleString('pt-BR', {
  style: 'currency',
  currency: 'BRL'
});

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextWeeklyRun(from = new Date()): Date {
  const next = new Date(from);
  const days = (7 - next.getUTCDay()) % 7;
  next.setUTCDate(next.getUTCDate() + days);
  next.setUTCHours(23, 0, 0, 0);
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

function nextMonthlyRun(from = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 11, 0, 0));
}

function weeklyWindow(now = new Date()) {
  const end = new Date(now);
  const start = new Date(now);
  const day = end.getUTCDay();
  start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
  return { from: iso(start), to: iso(end) };
}

function previousMonthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { from: iso(start), to: iso(end) };
}

export function formatCashSummary(title: string, summary: CashSummary): string {
  const categories = summary.categories.slice(0, 5)
    .map(item => `• ${item.category}: ${brl(item.amount)}`)
    .join('\n');
  return [
    `📊 *${title}*`,
    '',
    `Entradas: *${brl(summary.income)}*`,
    `Saídas: *${brl(summary.expense)}*`,
    `Saldo: *${brl(summary.balance)}*`,
    `Lançamentos: ${summary.count}`,
    categories ? `\nMaiores despesas:\n${categories}` : '',
    '',
    'Continue me enviando suas receitas e despesas por aqui.'
  ].filter(Boolean).join('\n');
}

export class CashReports {
  async ensureScheduled(companyId: string): Promise<void> {
    const weekly = nextWeeklyRun();
    const monthly = nextMonthlyRun();
    await Promise.all([
      platformJobService.enqueue({
        companyId,
        moduleKey: 'cash',
        type: 'cash.weekly-summary',
        payload: {},
        runAt: weekly,
        idempotencyKey: `cash-weekly-${iso(weekly)}`
      }),
      platformJobService.enqueue({
        companyId,
        moduleKey: 'cash',
        type: 'cash.monthly-summary',
        payload: {},
        runAt: monthly,
        idempotencyKey: `cash-monthly-${monthly.getUTCFullYear()}-${monthly.getUTCMonth() + 1}`
      })
    ]);
  }

  async weekly(context: ModuleJobContext): Promise<void> {
    const settings = await cashService.settings(context.companyId);
    if (settings.weekly_report_enabled && settings.owner_phone) {
      if (env.cashEvolutionInstance) {
        const window = weeklyWindow();
        const summary = await cashService.summary(context.companyId, window.from, window.to);
        await evolution.sendText({
          instanceName: env.cashEvolutionInstance,
          to: settings.owner_phone,
          text: formatCashSummary('Seu resumo da semana', summary)
        });
      }
    }
    await this.ensureScheduled(context.companyId);
  }

  async monthly(context: ModuleJobContext): Promise<void> {
    const settings = await cashService.settings(context.companyId);
    if (settings.monthly_report_enabled && settings.owner_phone) {
      if (env.cashEvolutionInstance) {
        const window = previousMonthWindow();
        const summary = await cashService.summary(context.companyId, window.from, window.to);
        await evolution.sendText({
          instanceName: env.cashEvolutionInstance,
          to: settings.owner_phone,
          text: formatCashSummary('Seu resumo do mês', summary)
        });
      }
    }
    await this.ensureScheduled(context.companyId);
  }
}

export const cashReports = new CashReports();

