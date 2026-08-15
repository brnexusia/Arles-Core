import { evolution } from '../../whatsapp/evolution.client.js';
import { env } from '../../config/env.js';
import { platformJobService } from '../../platform/jobs/job.service.js';
import type { ModuleJobContext } from '../../platform/modules/contract.js';
import { cashService } from './service.js';
import type { CashSummary } from './types.js';
import {
  addBrazilDays,
  currentWeekWindow,
  formatBrazilDate,
  monthBeforeWindow,
  nextFirstOfMonthAt8Brazil,
  nextMondayAt8Brazil,
  previousMonthWindow,
  previousWeekWindow
} from './time.js';

const brl = (value: number) => value.toLocaleString('pt-BR', {
  style: 'currency',
  currency: 'BRL'
});

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function categoryLines(summary: CashSummary): string {
  const lines = summary.categories
    .filter(item => item.amount > 0)
    .map(item => `- ${item.category}: ${brl(item.amount)}`);
  return lines.length ? lines.join('\n') : '- Nenhuma despesa no período';
}

export function formatCashSummary(title: string, summary: CashSummary): string {
  return [
    `📊 ${title}`,
    '',
    `💰 Entradas: ${brl(summary.income)}`,
    `💸 Saídas: ${brl(summary.expense)}`,
    `🏦 Saldo: ${brl(summary.balance)}`
  ].join('\n');
}

export function formatCashReport(input: {
  title: string;
  from: string;
  to: string;
  summary: CashSummary;
  name?: string | null;
  previous?: CashSummary | null;
}): string {
  const comparison = input.previous && input.previous.count > 0
    ? (() => {
        const diff = input.summary.expense - input.previous!.expense;
        const direction = diff > 0 ? 'a mais' : diff < 0 ? 'a menos' : 'igual';
        if (direction === 'igual') return '📈 Comparativo: suas despesas ficaram iguais ao período anterior.';
        return `📈 Comparativo: você gastou ${brl(Math.abs(diff))} ${direction} que no mês anterior.`;
      })()
    : '';

  return [
    `📊 ${input.title}`,
    `📅 ${formatBrazilDate(input.from)} a ${formatBrazilDate(input.to)}`,
    '',
    `💰 Receitas: ${brl(input.summary.income)}`,
    `💸 Despesas: ${brl(input.summary.expense)}`,
    `🏦 Saldo do período: ${brl(input.summary.balance)}`,
    '',
    '📂 Por categoria:',
    categoryLines(input.summary),
    comparison ? `\n${comparison}` : '',
    '',
    input.name ? `Bom trabalho, ${input.name}! 💪` : 'Bom trabalho! 💪'
  ].filter(Boolean).join('\n');
}

export class CashReports {
  private async send(to: string, body: string): Promise<void> {
    if (!env.cashEvolutionInstance || !to) return;
    await evolution.sendText({
      instanceName: env.cashEvolutionInstance,
      to,
      text: body
    });
  }

  async ensureScheduled(companyId: string): Promise<void> {
    const settings = await cashService.settings(companyId);
    const weekly = nextMondayAt8Brazil();
    const monthly = nextFirstOfMonthAt8Brazil();
    const jobs: Promise<string>[] = [
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
    ];

    if (settings.trial_started_at) {
      const day5 = addBrazilDays(settings.trial_started_at, 4);
      const day7 = addBrazilDays(settings.trial_started_at, 6);
      const day8 = addBrazilDays(settings.trial_started_at, 7);
      jobs.push(
        platformJobService.enqueue({
          companyId,
          moduleKey: 'cash',
          type: 'cash.trial-day5',
          payload: {},
          runAt: day5,
          idempotencyKey: `cash-trial-day5-${iso(settings.trial_started_at)}`
        }),
        platformJobService.enqueue({
          companyId,
          moduleKey: 'cash',
          type: 'cash.trial-day7',
          payload: {},
          runAt: day7,
          idempotencyKey: `cash-trial-day7-${iso(settings.trial_started_at)}`
        }),
        platformJobService.enqueue({
          companyId,
          moduleKey: 'cash',
          type: 'cash.trial-expired',
          payload: {},
          runAt: day8,
          idempotencyKey: `cash-trial-expired-${iso(settings.trial_started_at)}`
        })
      );
    }

    await Promise.all(jobs);
  }

  async weekly(context: ModuleJobContext): Promise<void> {
    const settings = await cashService.accessState(context.companyId);
    if (settings.hasAccess && settings.weekly_report_enabled && settings.owner_phone) {
      const window = previousWeekWindow();
      const summary = await cashService.summary(context.companyId, window.from, window.to);
      await this.send(settings.owner_phone, formatCashReport({
        title: 'Relatório Semanal',
        from: window.from,
        to: window.to,
        summary,
        name: settings.owner_name
      }));
    }
    await this.ensureScheduled(context.companyId);
  }

  async monthly(context: ModuleJobContext): Promise<void> {
    const settings = await cashService.accessState(context.companyId);
    if (settings.hasAccess && settings.monthly_report_enabled && settings.owner_phone) {
      const window = previousMonthWindow();
      const previousWindow = monthBeforeWindow(window.from);
      const [summary, previous] = await Promise.all([
        cashService.summary(context.companyId, window.from, window.to),
        cashService.summary(context.companyId, previousWindow.from, previousWindow.to)
      ]);
      await this.send(settings.owner_phone, formatCashReport({
        title: 'Relatório Mensal',
        from: window.from,
        to: window.to,
        summary,
        previous,
        name: settings.owner_name
      }));
    }
    await this.ensureScheduled(context.companyId);
  }

  async trialDay5(context: ModuleJobContext): Promise<void> {
    const settings = await cashService.accessState(context.companyId);
    if (settings.subscription_status !== 'trial' || !settings.owner_phone) return;
    const greeting = settings.owner_name ? `Hey ${settings.owner_name}! 👋` : 'Hey! 👋';
    await this.send(settings.owner_phone, [
      greeting,
      'Seu trial acaba em 2 dias.',
      'Para continuar usando o Arles Cash, escolha um plano:',
      '',
      cashService.paymentMenu()
    ].join('\n'));
  }

  async trialDay7(context: ModuleJobContext): Promise<void> {
    const settings = await cashService.accessState(context.companyId);
    if (settings.subscription_status !== 'trial' || !settings.owner_phone) return;
    const window = currentWeekWindow();
    const summary = await cashService.summary(context.companyId, window.from, window.to);
    const report = formatCashReport({
      title: 'Relatório Semanal',
      from: window.from,
      to: window.to,
      summary,
      name: settings.owner_name
    });
    await this.send(settings.owner_phone, [
      report,
      '',
      '---',
      '⏰ Seu trial encerra hoje!',
      'Continue acompanhando suas finanças — escolha seu plano:',
      '',
      cashService.paymentMenu()
    ].join('\n'));
  }

  async trialExpired(context: ModuleJobContext): Promise<void> {
    await cashService.expireTrial(context.companyId);
    const settings = await cashService.settings(context.companyId);
    if (settings.subscription_status === 'active' || !settings.owner_phone) return;
    await this.send(settings.owner_phone, [
      '⚠️ Seu trial encerrou.',
      'Seus dados estão salvos e seguros.',
      '',
      'Para reativar, escolha um plano:',
      '',
      cashService.paymentMenu()
    ].join('\n'));
  }
}

export const cashReports = new CashReports();
