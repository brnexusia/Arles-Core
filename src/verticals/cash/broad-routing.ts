import { normalizeCashText } from './management.js';

export type CashBroadRoute =
  | { kind: 'rewrite'; text: string }
  | { kind: 'plans' }
  | { kind: 'trial' }
  | { kind: 'categories' }
  | { kind: 'schedule' }
  | null;

const MONTHS = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';

function periodSuffix(input: string): string | null {
  const value = normalizeCashText(input);
  if (/\banteontem\b/.test(value)) return 'anteontem';
  if (/\bontem\b/.test(value)) return 'ontem';
  if (/\bhoje\b/.test(value) || /\b(do|meu|o) dia\b/.test(value)) return 'hoje';
  if (/\b(semana passada|ultima semana)\b/.test(value)) return 'semana passada';
  if (/\b(esta semana|essa semana|semana atual)\b/.test(value)) return 'esta semana';
  if (/\b(mes passado|ultimo mes)\b/.test(value)) return 'mês passado';
  if (/\b(este mes|esse mes|mes atual)\b/.test(value)) return 'este mês';
  if (/\b(ano passado|ultimo ano)\b/.test(value)) return 'ano passado';
  if (/\b(este ano|esse ano|ano atual)\b/.test(value)) return 'este ano';

  const fullDate = value.match(/\b(?:dia\s*)?(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\b/);
  if (fullDate?.[1]) return fullDate[1];

  const day = value.match(/\bdia\s+(\d{1,2})\b/);
  if (day?.[1]) return `dia ${day[1]}`;

  const month = value.match(new RegExp(`\\b(${MONTHS})(?:\\s+de\\s+(20\\d{2}))?\\b`));
  if (month?.[1]) return month[2] ? `${month[1]} de ${month[2]}` : month[1];

  return null;
}

function hasPeriod(input: string): boolean {
  return periodSuffix(input) !== null;
}

function safeTargetSuffix(value: string): string {
  const index = value.match(/\b(?:registro|registo|item|numero|n|#)?\s*(\d{1,2})\b/);
  if (index?.[1]) return index[1];
  return 'último';
}

function amountIn(value: string): string | null {
  const match = value.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i);
  return match?.[1] ?? null;
}

export function routeCashInput(input: string): CashBroadRoute {
  const value = normalizeCashText(input);
  if (!value) return null;

  // Ajuda e descoberta do produto.
  if (/\b(ajuda|menu|comandos?|guia|tutorial|instrucoes?|como usar|como mexer|como funciona|o que (?:da|posso) fazer|o que voce faz|me ensina|me explica como usar|quais funcoes)\b/.test(value)) {
    return { kind: 'rewrite', text: 'ajuda' };
  }

  // Planos, cobrança e reativação. Evita confundir com um lançamento comum "paguei ...".
  if (/^(?:quais? (?:sao )?os )?(?:planos?|precos?|valores?)(?: do arles cash)?[?.! ]*$/.test(value) ||
      /\b(quanto custa o arles|quanto custa usar|como assino|quero assinar|assinatura do arles|quero reativar|como reativo|renovar assinatura)\b/.test(value)) {
    return { kind: 'plans' };
  }

  // Trial/status de acesso.
  if (/\b(trial|teste gratis|periodo gratuito|quantos dias faltam|quando (?:acaba|termina|vence) (?:meu )?(?:trial|teste)|meu plano atual|status da assinatura)\b/.test(value)) {
    return { kind: 'trial' };
  }

  // Categorias automáticas.
  if (/\b(quais categorias|categorias disponiveis|categorias que existem|como categoriza|como voce categoriza|lista de categorias)\b/.test(value)) {
    return { kind: 'categories' };
  }

  // Agenda de relatórios automáticos.
  if (/\b(quando (?:manda|envia|recebo|chega) (?:o |os )?relatorio|horario (?:do|dos) relatorio|relatorios automaticos|agenda (?:do|dos) relatorio)\b/.test(value)) {
    return { kind: 'schedule' };
  }

  // Relatórios: famílias semanais e mensais.
  if (/\b(relatorio|fechamento|balanco|resumo|resultado|como foi)\b.*\b(semana|semanal)\b/.test(value) ||
      /\b(semana|semanal)\b.*\b(relatorio|fechamento|balanco|resumo)\b/.test(value)) {
    return { kind: 'rewrite', text: 'relatório semanal' };
  }
  if (/\b(relatorio|fechamento|balanco|resumo|resultado|como foi)\b.*\b(mes|mensal)\b/.test(value) ||
      /\b(mes|mensal)\b.*\b(relatorio|fechamento|balanco|resumo)\b/.test(value)) {
    return { kind: 'rewrite', text: 'relatório mensal' };
  }

  // Resumo/balanço com período explícito vira consulta completa do período.
  const period = periodSuffix(value);
  if (period && /\b(resumo|fechamento|balanco|panorama|movimentacoes?|movimentos?|resultado|como foi|o que rolou|o que teve|total do dia|saldo do dia|saldo de)\b/.test(value)) {
    return { kind: 'rewrite', text: `quais foram meus registros ${period}?` };
  }

  // "Resumo do dia" sem dizer "hoje".
  if (/\b(resumo|fechamento|balanco|panorama)\b.*\b(do|meu|o) dia\b/.test(value)) {
    return { kind: 'rewrite', text: 'quais foram meus registros hoje?' };
  }

  // Saldo/visão geral sem período específico.
  if (/^(?:meu )?(?:saldo|balanco|resumo)(?: atual)?[?.! ]*$/.test(value) ||
      /\b(quanto (?:tenho|sobrou)|como (?:estao|minhas) financas|como to de grana|situacao financeira|panorama financeiro|visao geral financeira|meu dinheiro agora|quanto tenho disponivel)\b/.test(value)) {
    return { kind: 'rewrite', text: 'saldo' };
  }

  // Histórico geral. Se houver período, é consulta e não apenas últimos registros.
  if (!hasPeriod(value) && /\b(historico|minhas ultimas movimentacoes|meus ultimos lancamentos|registros recentes|o que registrei|o que lancei|ultimos registros|ver meus registros|mostrar meus registros)\b/.test(value)) {
    return { kind: 'rewrite', text: 'histórico' };
  }

  // Consultas em linguagem cotidiana.
  if (/\bquanto\s+(?:que\s+)?(?:saiu|foi gasto|foi embora|desembolsei|torrei)\b/.test(value)) {
    return { kind: 'rewrite', text: value.replace(/\bquanto\s+(?:que\s+)?(?:saiu|foi gasto|foi embora|desembolsei|torrei)\b/, 'quanto gastei') };
  }
  if (/\bquanto\s+(?:que\s+)?(?:entrou|caiu|recebi ao todo|ganhei ao todo)\b/.test(value)) {
    return { kind: 'rewrite', text: value.replace(/\bquanto\s+(?:que\s+)?(?:entrou|caiu|recebi ao todo|ganhei ao todo)\b/, 'quanto recebi') };
  }
  if (/\b(?:o que|me mostra o que|mostra o que)\s+(?:saiu|gastei|paguei)\b/.test(value)) {
    return { kind: 'rewrite', text: value.replace(/\b(?:o que|me mostra o que|mostra o que)\s+(?:saiu|gastei|paguei)\b/, 'quais foram minhas despesas') };
  }
  if (/\b(?:o que|me mostra o que|mostra o que)\s+(?:entrou|recebi|ganhei)\b/.test(value)) {
    return { kind: 'rewrite', text: value.replace(/\b(?:o que|me mostra o que|mostra o que)\s+(?:entrou|recebi|ganhei)\b/, 'quais foram minhas receitas') };
  }
  if (period && /\b(me mostra tudo|mostra tudo|tudo que teve|tudo que rolou|movimentacoes?|movimentos?|lancamentos?|registros?)\b/.test(value)) {
    return { kind: 'rewrite', text: `quais foram meus registros ${period}?` };
  }
  if (/\b(onde gastei mais|em que gastei mais|qual compra foi mais cara|compra mais cara)\b/.test(value)) {
    return { kind: 'rewrite', text: `maior gasto ${period ?? 'este mês'}` };
  }

  // Edição natural do último registro. Só assume "último" quando há linguagem explícita de correção.
  if (/\b(corrige isso|corrigir isso|arruma isso|ajusta isso|altera isso|muda isso)\b/.test(value)) {
    return { kind: 'rewrite', text: 'edita o último' };
  }
  if (/\b(na verdade|corrigindo|correcao|errei o valor|valor errado)\b/.test(value)) {
    const amount = amountIn(value);
    if (amount) return { kind: 'rewrite', text: `muda o último para ${amount} reais` };
    return { kind: 'rewrite', text: 'edita o último' };
  }
  if (/\b(corrig|arrum|ajust|alter|mud)\w*\b/.test(value) && /\b(ultimo|registro|registo|lancamento|item|#|numero)\b/.test(value)) {
    return { kind: 'rewrite', text: `edita o ${safeTargetSuffix(value)}` };
  }

  // Exclusão natural do registro. Nunca trata conta/perfil/dados como lançamento.
  if (!/\b(conta|perfil|cadastro|dados pessoais)\b/.test(value)) {
    if (/\b(apaga isso|remove isso|exclui isso|cancela isso|nao era pra registrar|nao era para registrar|foi engano|lancamento duplicado|registro duplicado)\b/.test(value)) {
      return { kind: 'rewrite', text: 'apaga o último' };
    }
    if (/\b(apag|remov|exclu|cancel|delet)\w*\b/.test(value) && /\b(ultimo|registro|registo|lancamento|item|#|numero)\b/.test(value)) {
      return { kind: 'rewrite', text: `apaga o ${safeTargetSuffix(value)}` };
    }
  }

  return null;
}
