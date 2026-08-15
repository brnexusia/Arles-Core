import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { cashParser } from './parser.js';
import { cashReports, formatCashSummary } from './reports.js';
import { cashService } from './service.js';

const brl = (value: number) => value.toLocaleString('pt-BR', {
  style: 'currency',
  currency: 'BRL'
});

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function dateLabel(value: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (value === today) return 'hoje';
  if (value === yesterday) return 'ontem';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function currentWeek() {
  const end = new Date();
  const start = new Date();
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function currentMonth() {
  const now = new Date();
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10)
  };
}

function samePhone(left: string, right: string): boolean {
  const a = left.replace(/\D/g, '');
  const b = right.replace(/\D/g, '');
  return Boolean(a.length >= 10 && b.length >= 10 && (a === b || a.endsWith(b) || b.endsWith(a)));
}

export class CashHandler implements VerticalHandler {
  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    const { company, message, combinedText } = context;
    const normalized = combinedText.toLowerCase().trim();

    await cashService.rememberOwnerPhone(company.id, message.phone);
    const settings = await cashService.settings(company.id);
    if (settings.owner_phone && !samePhone(settings.owner_phone, message.phone)) {
      return null;
    }

    if (/\b(apagar|excluir|desfazer|remover)\b.*\b(último|ultimo|lançamento|lancamento)\b/.test(normalized)) {
      const removed = await cashService.deleteLast(company.id, message.phone);
      return removed
        ? text(`Pronto, removi o último lançamento de ${brl(Number(removed.amount))}.`)
        : text('Não encontrei nenhum lançamento para remover.');
    }

    if (/\b(resumo|saldo|quanto gastei|quanto entrou|quanto recebi)\b/.test(normalized)) {
      const period = /semana/.test(normalized) ? currentWeek() : currentMonth();
      const summary = await cashService.summary(company.id, period.from, period.to);
      return text(formatCashSummary(
        /semana/.test(normalized) ? 'Resumo da semana' : 'Resumo do mês',
        summary
      ));
    }

    if (/^(oi|olá|ola|bom dia|boa tarde|boa noite|ajuda|como funciona)[!. ]*$/i.test(combinedText.trim())) {
      return text([
        'Olá! Eu sou o *Arles Cash* 💰',
        '',
        'Me envie receitas e despesas do jeito que você fala normalmente:',
        '• “Gastei 15 no mercado hoje”',
        '• “Recebi 250 do cliente João”',
        '• “Paguei R$ 89,90 de internet ontem”',
        '',
        'Você também pode pedir “resumo da semana”, “resumo do mês” ou “apagar último lançamento”.'
      ].join('\n'));
    }

    const parsed = await cashParser.parse(combinedText);
    if (!parsed) {
      return text([
        'Não consegui identificar um lançamento completo.',
        'Envie o tipo e o valor, por exemplo: *“Gastei 15 no mercado hoje”*. '
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

    const detail = [
      parsed.merchant,
      parsed.category,
      dateLabel(parsed.transactionDate)
    ].filter(Boolean).join(' · ');

    return text([
      parsed.type === 'expense' ? '✅ *Despesa registrada*' : '✅ *Receita registrada*',
      `Valor: *${brl(Number(saved.amount))}*`,
      detail
    ].filter(Boolean).join('\n'));
  }
}

export const cashHandler = new CashHandler();
