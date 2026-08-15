import type { VerticalContext, VerticalHandler, VerticalResult } from '../vertical.js';
import { cashParser } from './parser.js';
import { cashQuery } from './query.js';
import { cashReports, formatCashReport, formatCashSummary } from './reports.js';
import { cashService } from './service.js';
import {
  asksHowToManage,
  deletionTarget,
  editTarget,
  hasCashEditPatch,
  managementHelpMessage,
  normalizeCashText,
  parseCashEditPatch,
  type CashEditPatch,
  type CashRecordTarget
} from './management.js';
import {
  clearCashEditState,
  getCashEditState,
  setCashEditState
} from './edit-state.js';
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
  return normalizeCashText(value);
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
    '📝 Registrar com descrição → “comprei uma blusinha na SHEIN de 15 reais”',
    '🔎 Pesquisar seus registros → “quanto gastei na SHEIN esse mês?”',
    '🔎 Filtrar por período → “quanto gastei ontem?” ou “gastos entre dia 1 e dia 10”',
    '🔎 Filtrar por valor → “mostra despesas acima de 100 reais”',
    '📊 Ver saldo → “saldo”',
    '📋 Histórico → “histórico”',
    '✏️ Editar registro → “edita o último” ou “edita o 2”',
    '🗑️ Remover registro → “retira o registro de agora” ou “apaga o 2”',
    '📅 Relatório semanal → “relatório semanal”',
    '📅 Relatório mensal → “relatório mensal”',
    '',
    'Se você pesquisar sem dizer a data, eu considero o mês atual.',
    'Pode escrever do seu jeito. Eu tento entender português natural, abreviações e gírias.'
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

function recordDescription(row: any): string {
  const value = String(row?.description ?? '').trim();
  return value ? ` — ${value}` : '';
}

function recordLine(row: any, index?: number): string {
  const icon = row.type === 'income' ? '💰' : '💸';
  const prefix = index == null ? '' : `${index}. `;
  return `${prefix}${icon} ${brl(Number(row.amount))} — ${row.category}${recordDescription(row)} (${dateLabel(String(row.transaction_date))})`;
}

function historyMessage(rows: Array<any>): string {
  if (!rows.length) return '📋 Você ainda não tem registros por aqui.';
  return [
    '📋 Seus últimos registros:',
    '',
    ...rows.map((row, index) => recordLine(row, index + 1)),
    '',
    'Para editar ou apagar, você pode dizer “edita o 2” ou “apaga o 2”.'
  ].join('\n');
}

function editPrompt(row: any): string {
  return [
    '✏️ Certo. Vamos editar este registro:',
    recordLine(row),
    '',
    'Me diga o que quer mudar. Exemplos:',
    '• “o valor foi 18 reais”',
    '• “categoria Pessoal”',
    '• “descrição: blusinha na SHEIN”',
    '• “foi ontem”',
    '',
    'Se mudar de ideia, mande “cancelar edição”.'
  ].join('\n');
}

function updatedMessage(row: any): string {
  return [
    '✅ Registro atualizado!',
    `📂 Categoria: ${row.category}`,
    `${row.type === 'income' ? '💰' : '💸'} Valor: ${brl(Number(row.amount))}`,
    row.description ? `📝 Descrição: ${row.description}` : '',
    `📅 Data: ${formatBrazilDate(String(row.transaction_date))}`
  ].filter(Boolean).join('\n');
}

async function resolveRecentTarget(companyId: string, phone: string, target: CashRecordTarget): Promise<any | null> {
  const rows = await cashService.listRecent(companyId, phone, target.kind === 'index' ? Math.max(5, target.index) : 1);
  if (target.kind === 'last') return rows[0] ?? null;
  return rows[target.index - 1] ?? null;
}

async function applyEdit(companyId: string, row: any, patch: CashEditPatch): Promise<any> {
  const nextType = patch.type ?? row.type;
  const nextCategory = nextType === 'income'
    ? 'Receita'
    : (patch.category ?? row.category);

  return await cashService.updateTransaction(companyId, String(row.id), {
    type: nextType,
    amount: patch.amount ?? Number(row.amount),
    category: nextCategory,
    merchant: row.merchant ?? null,
    description: patch.description ?? row.description ?? null,
    transaction_date: patch.transaction_date ?? String(row.transaction_date)
  });
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

    // Uma edição iniciada por “edita o último” fica aberta por alguns minutos para
    // aceitar respostas naturais como “o valor foi 18 e foi ontem”.
    const pendingEditId = await getCashEditState(company.id, message.phone);
    if (pendingEditId) {
      if (/^(cancelar|cancela|cancelar edicao|cancelar edição|deixa pra la|deixa pra lá)[!. ]*$/.test(normalized)) {
        await clearCashEditState(company.id, message.phone);
        return text('Tudo bem 😊 Edição cancelada. O registro continua como estava.');
      }

      const rows = await cashService.listRecent(company.id, message.phone, 20);
      const editing = rows.find((row: any) => String(row.id) === pendingEditId);
      if (!editing) {
        await clearCashEditState(company.id, message.phone);
      } else {
        const patch = parseCashEditPatch(combinedText);
        if (hasCashEditPatch(patch)) {
          const updated = await applyEdit(company.id, editing, patch);
          await clearCashEditState(company.id, message.phone);
          return text(updatedMessage(updated));
        }

        if (/^(ajuda|como|o que posso mudar|o que da pra mudar|o que dá pra mudar)[!.? ]*$/.test(normalized)) {
          return text(editPrompt(editing));
        }

        return text([
          'Não consegui identificar o que você quer mudar nesse registro 🤔',
          '',
          'Tente algo como:',
          '• “o valor foi 18 reais”',
          '• “categoria Pessoal”',
          '• “descrição: blusinha na SHEIN”',
          '• “foi ontem”',
          '',
          'Ou mande “cancelar edição”.'
        ].join('\n'));
      }
    }

    // Perguntas sobre como editar/remover devem ensinar, nunca apagar algo por engano.
    if (asksHowToManage(combinedText)) {
      return text(managementHelpMessage());
    }

    if (/^(ajuda|menu|comandos|me ajuda|como usar|como uso|o que voce faz|o que você faz|o que posso fazer|como funciona)[!.? ]*$/.test(normalized)) {
      return text(helpMessage());
    }

    const removeTarget = deletionTarget(combinedText);
    if (removeTarget) {
      const row = await resolveRecentTarget(company.id, message.phone, removeTarget);
      if (!row) return text('Não encontrei esse registro para excluir. Mande “histórico” para ver os últimos.');
      await cashService.deleteTransaction(company.id, String(row.id));
      await clearCashEditState(company.id, message.phone);
      return text([
        '🗑️ Registro excluído:',
        recordLine(row),
        '',
        'Feito! Se quiser, registre novamente.'
      ].join('\n'));
    }

    const targetToEdit = editTarget(combinedText);
    if (targetToEdit) {
      const row = await resolveRecentTarget(company.id, message.phone, targetToEdit);
      if (!row) return text('Não encontrei esse registro para editar. Mande “histórico” para ver os últimos.');
      const patch = parseCashEditPatch(combinedText);
      if (hasCashEditPatch(patch)) {
        const updated = await applyEdit(company.id, row, patch);
        return text(updatedMessage(updated));
      }
      await setCashEditState(company.id, message.phone, String(row.id));
      return text(editPrompt(row));
    }

    // Pesquisa financeira em linguagem natural. A IA, quando necessária, só extrai
    // filtros; totais e linhas sempre vêm do PostgreSQL.
    const queryResult = await cashQuery.handle(company.id, combinedText);
    if (queryResult) return queryResult;

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
      if (/\b(edit|alter|mud|apag|exclu|remov|retir|observa|descricao|registro|registo)\w*/.test(normalized)) {
        return text(managementHelpMessage());
      }
      return text([
        'Hmm, não entendi bem 🤔',
        'Tente assim: “gastei 80 no mercado”, “recebi 2000 de salário” ou “quanto gastei no mercado?”',
        'Se quiser ver tudo que dá para fazer, mande “ajuda”.'
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
      parsed.description ? `📝 Descrição: ${parsed.description}` : '',
      `📅 Data: ${formatBrazilDate(parsed.transactionDate)}`
    ].filter(Boolean).join('\n'));
  }
}

export const cashHandler = new CashHandler();
