import { normalizeCashText } from './management.js';

export type CashHelpSection =
  | 'menu'
  | 'register'
  | 'query'
  | 'manage'
  | 'reports'
  | 'plans';

export function cashHelpSection(input: string): CashHelpSection | null {
  const value = normalizeCashText(input);
  if (!value) return null;

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(registrar|registro|lancar|lancamento|despesa|receita|guardar|reserva)\b/.test(value)
    || /^(?:registrar|registro|lancamentos?|despesas?|receitas?)$/.test(value)) return 'register';

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(consultar|consulta|pesquisar|pesquisa|buscar|gastos|saldo|historico|lista)\b/.test(value)
    || /^(?:consultar|consulta|pesquisar|pesquisa|historico|saldo)$/.test(value)) return 'query';

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(editar|corrigir|alterar|apagar|remover|excluir|desfazer)\b/.test(value)
    || /^(?:editar|corrigir|apagar|remover|excluir|desfazer)$/.test(value)) return 'manage';

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(relatorio|relatorios|semanal|mensal)\b/.test(value)
    || /^(?:relatorios?|semanal|mensal)$/.test(value)) return 'reports';

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(plano|planos|preco|precos|pagamento|assinar|trial|teste gratis)\b/.test(value)
    || /^(?:planos?|pagamento|trial)$/.test(value)) return 'plans';

  if (/^(ajuda|menu|comandos|guia|guia de ajuda|tutorial|me ajuda|me ensina|como usar|como uso|o que voce faz|o que posso fazer|como funciona)[!.? ]*$/.test(value)) return 'menu';

  const numbered = value.match(/^(?:opcao|opção)?\s*([1-5])$/);
  if (numbered?.[1] === '1') return 'register';
  if (numbered?.[1] === '2') return 'query';
  if (numbered?.[1] === '3') return 'manage';
  if (numbered?.[1] === '4') return 'reports';
  if (numbered?.[1] === '5') return 'plans';

  return null;
}

export function cashHelpMessage(section: CashHelpSection): string {
  if (section === 'register') {
    return [
      '💸 *Registrar movimentações*',
      '',
      'É só falar normalmente:',
      '• “gastei 50 no mercado”',
      '• “paguei 100 nas unhas”',
      '• “recebi 2.000 de salário”',
      '• “guardei 300”',
      '',
      'Pode mandar vários lançamentos na mesma mensagem que eu separo para você.',
      '',
      'Digite *ajuda* para voltar ao menu.'
    ].join('\n');
  }

  if (section === 'query') {
    return [
      '🔎 *Consultar suas finanças*',
      '',
      'Pergunte do seu jeito:',
      '• “quanto gastei hoje?”',
      '• “faz uma lista do que gastei esse mês”',
      '• “quanto gastei na SHEIN?”',
      '• “quais foram meus gastos de ontem?”',
      '• “qual foi meu maior gasto?”',
      '• “quanto tenho de saldo?”',
      '',
      'Você também pode continuar uma consulta com: “e ontem?” ou “e mês passado?”.',
      '',
      'Digite *ajuda* para voltar ao menu.'
    ].join('\n');
  }

  if (section === 'manage') {
    return [
      '✏️ *Editar ou excluir registros*',
      '',
      'Exemplos:',
      '• “edita o último”',
      '• “o valor foi 80, não 100”',
      '• “apaga o último”',
      '• “remove o 2”',
      '• “coloca ele de novo” para desfazer uma exclusão recente',
      '',
      'Antes de apagar ou alterar, eu só executo quando a intenção estiver clara.',
      '',
      'Digite *ajuda* para voltar ao menu.'
    ].join('\n');
  }

  if (section === 'reports') {
    return [
      '📅 *Relatórios*',
      '',
      'Você pode pedir:',
      '• “relatório semanal”',
      '• “relatório mensal”',
      '• “resumo de hoje”',
      '',
      'Automáticos:',
      '• Segunda-feira às 08:00 → semana anterior',
      '• Dia 1 às 08:00 → mês anterior',
      '',
      'Digite *ajuda* para voltar ao menu.'
    ].join('\n');
  }

  if (section === 'plans') {
    return [
      '💳 *Planos e trial*',
      '',
      '• “o que é trial?” → explico seu teste gratuito',
      '• “quantos dias faltam?” → mostro seu prazo',
      '• “planos” → mostro as opções e os links de pagamento',
      '• “meu plano” → mostro seu acesso atual',
      '',
      'O pagamento é liberado automaticamente após a confirmação da Cakto.',
      '',
      'Digite *ajuda* para voltar ao menu.'
    ].join('\n');
  }

  return [
    '💡 *Ajuda do Arles Cash*',
    '',
    'O que você quer aprender?',
    '',
    '1️⃣ Registrar gastos, receitas e reservas',
    '2️⃣ Consultar gastos, saldo e histórico',
    '3️⃣ Editar ou excluir registros',
    '4️⃣ Relatórios e resumos',
    '5️⃣ Planos, pagamento e trial',
    '',
    'Responda com o número ou fale naturalmente, por exemplo: “como consulto meus gastos?”.'
  ].join('\n');
}
