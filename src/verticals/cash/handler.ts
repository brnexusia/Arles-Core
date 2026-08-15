import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { cashParser } from './parser.js';
import { cashReports, formatCashReport, formatCashSummary } from './reports.js';
import { cashService } from './service.js';
import {
  currentMonthWindow,
  currentWeekWindow,
  dateIsoOffset,
  formatBrazilDate,
  isoBrazil,
  monthBeforeWindow
} from './time.js';

const brl = (value: number) => value.toLocaleString('pt-BR', {
  style: 'currency',
  currency: 'BRL'
});

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function dateLabel(value: string): string {
  if (value === isoBrazil()) return 'hoje';
  if (value === dateIsoOffset(-1)) return 'ontem';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function looksLikeName(value: string): boolean {
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 80 || /\d/.test(clean)) return false;
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'´` -]+$/.test(clean)) return false;
  return !/^(oi|ola|olá|quero começar|quero comecar|ajuda|menu|saldo|resumo|historico|histórico)$/i.test(clean);
}

function helpMessage(): string {
  return [
    '💡 O que você pode fazer aqui:',
    '',
    '💸 Registrar despesa → “gastei 50 no mercado”',
    '💰 Registrar receita → “recebi 2000 de salário”',
    '📊 Ver saldo → “saldo”',
    '📋 Histórico → “histórico”',
    '📅 Relatório semanal → “relatório semanal”',
    '📅 Relatório mensal → “relatório mensal”',
    '🗑️ Apagar último → “apaga o último”'
  ].join('\n');
}

function expiredMessage(): string {
  return [
    '⚠️ Seu trial encerrou.',
    'Seus dados estão salvos e seguros.',
    '',
    'Para reativar, escolha um plano:',
    '',
    cashService.paymentMenu()
  ].join('\n');
}

function historyMessage(rows: Array<any>): string {
  if (!rows.length) return '📋 Você ainda não tem registros por aqui.';
  return [
    '📋 Seus últimos registros:',
    '',
    ...rows.map((row, index) => {
      const icon = row.type === 'income' ? '💰' : '💸';
      return `${index + 1}. ${icon} ${brl(Number(row.amount))} — ${row.category} (${dateLabel(String(row.transaction_date))})`;
    })
  ].join('\n');
}

export class CashHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    const { company, message, combinedText } = context;
    const normalized = normalize(combinedText);
    let settings = await cashService.settings(company.id);

    // Primeiro contato: a conta já foi criada pelo número remetente.
    if (settings.onboarding_state === 'welcome') {
      await cashService.beginOnboarding(company.id);
      await cashReports.ensureScheduled(company.id);
      return text([
        'Oi! Seja bem-vindo ao Arles Cash 💰',
        'Seu assistente financeiro direto no WhatsApp.',
        'Antes de começar, qual é o seu nome?'
      ].join('\n'));
    }

    if (settings.onboarding_state === 'awaiting_name') {
      if (!looksLikeName(combinedText)) {
        return text('Antes de começar, me diz seu nome 😊');
      }
      const completed = await cashService.completeOnboarding(company.id, combinedText);
      await cashReports.ensureScheduled(company.id);
      const accessAfterName = await cashService.accessState(company.id);
      if (!accessAfterName.hasAccess) {
        return text([
          `Perfeito, ${completed.owner_name}!`,
          'Seu perfil está pronto, mas o trial de 7 dias iniciado no primeiro contato já encerrou.',
          '',
          'Seus dados continuam salvos. Para ativar o Arles Cash:',
          '',
          cashService.paymentMenu()
        ].join('\n'));
      }
      return text([
        `Perfeito, ${completed.owner_name}! 🎉`,
        'Seu trial gratuito de 7 dias está ativo.',
        'Você pode registrar receitas, despesas e consultar seu saldo aqui mesmo.',
        'Já pode começar! Tente mandar: “Gastei 50 no mercado”'
      ].join('\n'));
    }

    const access = await cashService.accessState(company.id);
    settings = access;
    if (!access.hasAccess) return text(expiredMessage());

    if (/^(ajuda|menu|comandos|o que voce faz|o que você faz|como funciona)[!.? ]*$/.test(normalized)) {
      return text(helpMessage());
    }

    if (
      /\b(apaga|apagar|exclui|excluir|remove|remover|cancela|cancelar)\b.*\b(ultimo|último|lancamento|lançamento|registro)\b/.test(normalized) ||
      /^(errei|foi errado|registrei errado)[!. ]*$/.test(normalized)
    ) {
      const removed = await cashService.deleteLast(company.id, message.phone);
      if (!removed) return text('Não encontrei nenhum registro para excluir.');
      const icon = removed.type === 'income' ? '💰' : '💸';
      return text([
        '🗑️ Registro excluído:',
        `${icon} ${brl(Number(removed.amount))} — ${removed.category} (${dateLabel(String(removed.transaction_date))})`,
        '',
        'Feito! Se quiser, registre novamente.'
      ].join('\n'));
    }

    if (/^(historico|histórico|ultimos|últimos|o que registrei|meus registros)[!.? ]*$/.test(normalized)) {
      return text(historyMessage(await cashService.listRecent(company.id, message.phone, 5)));
    }

    if (/^(relatorio semanal|relatório semanal|semana|como foi a semana|resumo da semana)[!.? ]*$/.test(normalized)) {
      const period = currentWeekWindow();
      const summary = await cashService.summary(company.id, period.from, period.to);
      return text(formatCashReport({
        title: 'Relatório Semanal',
        from: period.from,
        to: period.to,
        summary,
        name: settings.owner_name
      }));
    }

    if (/^(relatorio mensal|relatório mensal|mes|mês|como foi o mes|como foi o mês|resumo do mes|resumo do mês)[!.? ]*$/.test(normalized)) {
      const period = currentMonthWindow();
      const previousPeriod = monthBeforeWindow(period.from);
      const [summary, previous] = await Promise.all([
        cashService.summary(company.id, period.from, period.to),
        cashService.summary(company.id, previousPeriod.from, previousPeriod.to)
      ]);
      return text(formatCashReport({
        title: 'Relatório Mensal',
        from: period.from,
        to: period.to,
        summary,
        previous,
        name: settings.owner_name
      }));
    }

    if (/^(saldo|quanto tenho|como to|como tô|resumo|meu saldo|saldo atual)[!.? ]*$/.test(normalized)) {
      const period = currentMonthWindow();
      const summary = await cashService.summary(company.id, period.from, period.to);
      const monthName = new Intl.DateTimeFormat('pt-BR', {
        month: 'long',
        year: 'numeric',
        timeZone: 'America/Sao_Paulo'
      }).format(new Date());
      return text(formatCashSummary(`Seu saldo atual — ${monthName}`, summary));
    }

    const parsed = await cashParser.parse(combinedText);
    if (!parsed) {
      return text([
        'Hmm, não entendi bem 🤔',
        'Tente assim: “gastei 80 no mercado” ou “recebi 2000 de salário”',
        'Ou mande “ajuda” para ver todos os comandos.'
      ].join('\n'));
    }

    const saved = await cashService.createTransaction({
      companyId: company.id,
      phone: message.phone,
      sourceMessageId: message.messageId,
      sourceMessage: combinedText,
      transaction: parsed
    });
    await cashReports.ensureScheduled(company.id);

    return text([
      '✅ Registrado!',
      `📂 Categoria: ${parsed.category}`,
      `${parsed.type === 'expense' ? '💸' : '💰'} Valor: ${brl(Number(saved.amount))}`,
      `📅 Data: ${formatBrazilDate(parsed.transactionDate)}`
    ].join('\n'));
  }
}

export const cashHandler = new CashHandler();
