import { normalizeCashText } from './management.js';

export type CashHelpSection =
  | 'menu'
  | 'register'
  | 'query'
  | 'pockets'
  | 'forecasts'
  | 'manage'
  | 'reports'
  | 'plans';

export function cashHelpSection(input: string): CashHelpSection | null {
  const value = normalizeCashText(input);
  if (!value) return null;

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(agendar|agendamento|previsao|previsoes|previsto|previstos|projecao futura|contas futuras)\b/.test(value)
    || /^(?:agendamento|agendamentos|previsao|previsoes|previstos?|agenda financeira)$/.test(value)) return 'forecasts';

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(cofrinho|cofrinhos|caixinha|caixinhas|separar dinheiro)\b/.test(value)
    || /^(?:cofrinho|cofrinhos|caixinha|caixinhas)$/.test(value)) return 'pockets';

  // Gestão vem antes de “registro”: “como edito um registro?” é ajuda de edição,
  // não instrução de como registrar uma movimentação nova.
  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(editar|edito|corrigir|corrijo|alterar|altero|apagar|apago|remover|removo|excluir|excluo|desfazer|desfaco)\b/.test(value)
    || /^(?:editar|corrigir|apagar|remover|excluir|desfazer)$/.test(value)) return 'manage';

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(registrar|registro|lancar|lancamento|despesa|receita|guardar|reserva)\b/.test(value)
    || /^(?:registrar|registro|lancamentos?|despesas?|receitas?)$/.test(value)) return 'register';

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(consultar|consulta|pesquisar|pesquisa|buscar|gastos|saldo|historico|lista|simular|simulacao)\b/.test(value)
    || /^(?:consultar|consulta|pesquisar|pesquisa|historico|saldo|simular|simulacao)$/.test(value)) return 'query';

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(relatorio|relatorios|semanal|mensal)\b/.test(value)
    || /^(?:relatorios?|semanal|mensal)$/.test(value)) return 'reports';

  if (/\b(ajuda|guia|como|ensina|explica)\b.*\b(plano|planos|preco|precos|pagamento|assinar|trial|teste gratis)\b/.test(value)
    || /^(?:planos?|pagamento|trial)$/.test(value)) return 'plans';

  if (/^(ajuda|menu|comandos|guia|guia de ajuda|tutorial|me ajuda|me ensina|como usar|como uso|o que voce faz|o que posso fazer|como funciona)[!.? ]*$/.test(value)) return 'menu';

  const numbered = value.match(/^(?:opcao|opção)?\s*([1-7])$/);
  if (numbered?.[1] === '1') return 'register';
  if (numbered?.[1] === '2') return 'query';
  if (numbered?.[1] === '3') return 'pockets';
  if (numbered?.[1] === '4') return 'forecasts';
  if (numbered?.[1] === '5') return 'manage';
  if (numbered?.[1] === '6') return 'reports';
  if (numbered?.[1] === '7') return 'plans';

  return null;
}

export function cashHelpMessage(section: CashHelpSection): string {
  if (section === 'register') {
    return [
      '💸 *Registrar movimentações reais*',
      '',
      'É só falar normalmente:',
      '• “gastei 50 no mercado”',
      '• “paguei 100 nas unhas”',
      '• “recebi 2.000 de salário”',
      '• “guardei 300”',
      '',
      'Pode mandar vários lançamentos na mesma mensagem que eu separo para você.',
      'Antes de salvar, eu mostro o que entendi e peço sua confirmação.',
      '',
      'Importante: previsão e simulação não entram aqui como gasto/receita real.',
      '',
      'Digite *ajuda* para voltar ao menu.'
    ].join('\n');
  }

  if (section === 'query') {
    return [
      '🔎 *Consultar, saldo e simular*',
      '',
      'Pergunte do seu jeito:',
      '• “quanto gastei hoje?”',
      '• “faz uma lista do que gastei esse mês”',
      '• “quanto tenho de saldo?”',
      '• “se eu gastar 25, quanto fica meu saldo?”',
      '• “tenho saldo de 100, se eu gastar 37,50 quanto sobra?”',
      '',
      'Seu saldo real é acumulado: entradas reais − saídas reais.',
      'Simulações não registram nada; servem apenas para fazer a conta.',
      '',
      'Para contas futuras recorrentes, use a opção de previsões/agendamentos.',
      '',
      'Digite *ajuda* para voltar ao menu.'
    ].join('\n');
  }

  if (section === 'pockets') {
    return [
      '🐷 *Cofrinhos de organização*',
      '',
      'Separe seus lançamentos por finalidade sem duplicar dinheiro:',
      '• “criar cofrinho Emprego”',
      '• “criar cofrinho Viagem”',
      '• “recebi 500 no cofrinho Emprego”',
      '• “gastei 30 do cofrinho Viagem”',
      '• “saldo do cofrinho Emprego”',
      '• “quanto gastei no cofrinho Viagem?”',
      '• “extrato do cofrinho Emprego”',
      '• “meus cofrinhos”',
      '',
      'Você também pode responder/citar um lançamento e dizer “coloca esse no cofrinho Viagem”.',
      'Previsões também podem apontar para um cofrinho.',
      '',
      'Digite *ajuda* para voltar ao menu.'
    ].join('\n');
  }

  if (section === 'forecasts') {
    return [
      '🔮 *Previsões e agendamentos financeiros*',
      '',
      'Use para dinheiro que ainda vai entrar ou sair:',
      '• “todo dia 10 pago 300 do cartão”',
      '• “todo dia 5 recebo 2.000 de salário”',
      '• “toda sexta gasto 50 com almoço”',
      '• “todos os dias gasto 12 no café”',
      '• “amanhã vou receber 800 de um cliente”',
      '',
      'Consultar:',
      '• “quanto vou ter no fim do mês?”',
      '• “quanto vou gastar este mês?”',
      '• “quanto vou receber este mês?”',
      '• “meus agendamentos”',
      '',
      'Gerenciar:',
      '• “cancela agendamento 2”',
      '',
      'Previsões entram somente no saldo projetado. Elas NÃO alteram seu saldo real e NÃO viram lançamento real automaticamente.',
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
      'Você pode citar a mensagem original para eu saber exatamente qual lançamento quer alterar.',
      'Se você editar no próprio WhatsApp uma mensagem que originou um lançamento, eu tento sincronizar o registro correspondente.',
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
      'Relatórios mostram realizado. Projeções futuras ficam separadas.',
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
    '1️⃣ Registrar gastos, receitas e reservas reais',
    '2️⃣ Consultar saldo, gastos e fazer simulações',
    '3️⃣ Criar e usar cofrinhos',
    '4️⃣ Previsões e agendamentos financeiros',
    '5️⃣ Editar ou excluir registros',
    '6️⃣ Relatórios e resumos',
    '7️⃣ Planos, pagamento e trial',
    '',
    'Responda com o número ou fale naturalmente, por exemplo: “como agendo uma conta todo mês?”.'
  ].join('\n');
}
