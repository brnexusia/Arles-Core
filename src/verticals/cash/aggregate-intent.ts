function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
const MONTH_SET = new Set(MONTHS.split('|'));

export type CashAggregateFlow = 'income' | 'expense' | 'both';
export type CashAggregateScope = 'all_time' | 'period';

export interface CashAggregateIntent {
  flow: CashAggregateFlow;
  scope: CashAggregateScope;
  periodCanonical: string | null;
}

function historicalBoundaryCue(value: string): boolean {
  return /\b(?:desde o inicio|desde que comecei|desde sempre|ate agora|ate hoje|vida toda|todo o historico|historico inteiro|historico completo)\b/.test(value);
}

function allTimeCue(value: string): boolean {
  return /\b(?:total geral|geral|global|acumulad\w*|historico completo|historico inteiro|historico todo|todo o historico|desde o inicio|desde que comecei|desde sempre|ate agora|ate hoje|no geral|ao todo|no total|de tudo|tudo que|tudo o que|todos? os lancamentos|todos? os registros|todas? as movimentacoes|vida toda)\b/.test(value);
}

function aggregateCue(value: string): boolean {
  return /\b(?:soma|some|somar|somando|calculo|calcula|calcule|calcular|total|totaliza|totalizar|totalizando|valor total|valor acumulado|acumulado|balanco|fechamento|quanto deu|quanto ficou|quanto foi|quanto ja|ao todo|no total|resumo)\b/.test(value);
}

function incomeCue(value: string): boolean {
  return /\b(?:ganhei|ganho|ganhos|recebi|recebido|recebimentos?|receitas?|entradas?|entrou|entraram|caiu|cairam|vendi|vendas?|faturei|faturamento|renda|salario|dinheiro que entrou|o que entrou)\b/.test(value);
}

function expenseCue(value: string): boolean {
  return /\b(?:gastei|gasto|gastos|despesas?|saidas?|saiu|sairam|paguei|pagamentos?|comprei|compras?|custos?|dinheiro que saiu|o que saiu)\b/.test(value);
}

function recordCue(value: string): boolean {
  return /\b(?:lancamentos?|registros?|movimentacoes?|historico)\b/.test(value);
}

function requestCue(value: string): boolean {
  return /\b(?:quanto|qual|quero saber|me diz|me diga|me fala|mostra|mostre|manda|mande|passa|passe|traz|traga|calculo|calcula|calcule|calcular|soma|some|somar|totaliza|totalizar|resumo|balanco|fechamento)\b/.test(value);
}

function hasMoney(value: string): boolean {
  return /(?:r\$\s*)?\d{1,3}(?:\.\d{3})*(?:[.,]\d{1,2})?/.test(value);
}

function looksLikeMutation(value: string): boolean {
  return /\b(?:apaga|apagar|exclui|excluir|remove|remover|deleta|deletar|cancela|cancelar|edita|editar|corrige|corrigir|altera|alterar)\b/.test(value);
}

function looksLikeProjection(value: string): boolean {
  return /\b(?:se eu|e se|simula|simular|simulacao|sem registrar|nao registra|vou|irei|pretendo)\b/.test(value)
    && /\b(?:gast\w*|pag\w*|compr\w*|receb\w*|ganh\w*|entr\w*|sai\w*|saldo|sobr\w*|fic\w*)\b/.test(value);
}

function hasSpecificFilter(value: string): boolean {
  if (/\b(?:maior|menor|mais caro|mais cara|mais barato|mais barata|acima de|abaixo de|mais de|menos de|entre)\b/.test(value)) return true;
  if (/\b(?:alimentacao|transporte|saude|moradia|educacao|pessoal|reserva)\b/.test(value)) return true;

  const generic = new Set([
    'hoje', 'ontem', 'anteontem', 'mes', 'semana', 'ano', 'dia', 'dias',
    'total', 'geral', 'tudo', 'todos', 'todas', 'que', 'o', 'a', 'valor', 'dinheiro',
    'gasto', 'gastos', 'despesa', 'despesas', 'receita', 'receitas', 'entrada', 'entradas',
    'saida', 'saidas', 'lancamento', 'lancamentos', 'registro', 'registros', 'movimentacao', 'movimentacoes'
  ]);

  const matches = value.matchAll(/\b(?:na|no|em|com|de|da|do|pela|pelo)\s+([a-z0-9][a-z0-9_-]*)/g);
  for (const match of matches) {
    const token = match[1];
    if (!token || generic.has(token) || MONTH_SET.has(token) || /^20\d{2}$/.test(token)) continue;
    return true;
  }
  return false;
}

function periodCanonical(value: string): string | null {
  if (/\banteontem\b/.test(value)) return 'anteontem';
  if (/\bontem\b/.test(value)) return 'ontem';
  if (/\bhoje\b/.test(value)) return 'hoje';

  if (/\b(?:esta|essa|nesta|nessa|desta|dessa) semana\b|\bsemana atual\b/.test(value)) return 'esta semana';
  if (/\b(?:semana passada|ultima semana)\b/.test(value)) return 'semana passada';

  if (/\b(?:este|esse|neste|nesse|deste|desse) mes\b|\bmes atual\b/.test(value)) return 'este mês';
  if (/\b(?:mes passado|ultimo mes)\b/.test(value)) return 'mês passado';

  if (/\b(?:este|esse|neste|nesse|deste|desse) ano\b|\bano atual\b/.test(value)) return 'este ano';
  if (/\b(?:ano passado|ultimo ano)\b/.test(value)) return 'ano passado';

  const lastDays = value.match(/\bultim(?:os|as)\s+(\d{1,3})\s+dias?\b/);
  if (lastDays?.[1]) return `últimos ${lastDays[1]} dias`;

  const month = value.match(new RegExp(`\\b(${MONTHS})(?:\\s+de\\s+(20\\d{2}))?\\b`));
  if (month?.[1]) {
    const name = month[1] === 'marco' ? 'março' : month[1];
    return month[2] ? `${name} de ${month[2]}` : name;
  }

  const fullRange = value.match(/\b(?:entre|de)\s+(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\s+(?:e|ate|a)\s+(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\b/);
  if (fullRange?.[1] && fullRange[2]) return `de ${fullRange[1]} a ${fullRange[2]}`;

  const fullDate = value.match(/\b(?:dia\s*)?(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\b/);
  if (fullDate?.[1]) return fullDate[1];

  return null;
}

export function hasCashExplicitAggregatePeriod(input: string): boolean {
  const value = normalize(input);
  if (!value) return false;
  if (historicalBoundaryCue(value)) return false;
  return periodCanonical(value) !== null;
}

/**
 * Interpreta pedidos de soma/resumo pela intenção financeira, não por frases cadastradas.
 *
 * Regras de escopo:
 * - período citado sempre vence: “total deste mês” = este mês;
 * - limite histórico explícito (“desde o início”, “até agora”) = histórico inteiro;
 * - sinais fortes de totalidade (“total geral”, “de tudo”, “todos os lançamentos”) = histórico inteiro;
 * - soma de “lançamentos/registros/movimentações” sem período = histórico inteiro;
 * - sem período e sem sinal histórico = hoje, mantendo a convenção atual do Cash.
 * - consultas com loja/categoria/faixa de valor ficam no motor de filtros, não neste resumo.
 */
export function parseCashAggregateIntent(input: string): CashAggregateIntent | null {
  const value = normalize(input);
  if (!value) return null;

  if (/\b(?:cofrinh|caixinh|envelope|potinh|pote)\w*/.test(value)) return null;
  if (looksLikeMutation(value) || looksLikeProjection(value)) return null;

  const income = incomeCue(value);
  const expense = expenseCue(value);
  const records = recordCue(value);
  const aggregate = aggregateCue(value);
  const asksHowMuch = /\bquanto\b/.test(value) && (income || expense || records);
  const genericSummary = /\b(?:balanco|resumo|fechamento)\b/.test(value)
    || (aggregate && /\btudo\b/.test(value));

  if (!aggregate && !asksHowMuch) return null;
  if (!income && !expense && !records && !genericSummary) return null;

  if (hasSpecificFilter(value)) return null;

  if (hasMoney(value) && !requestCue(value) && !/\?$/.test(String(input).trim())) return null;

  const flow: CashAggregateFlow = income && expense
    ? 'both'
    : income
      ? 'income'
      : expense
        ? 'expense'
        : 'both';

  const explicitPeriod = periodCanonical(value);
  if (explicitPeriod) {
    return { flow, scope: 'period', periodCanonical: explicitPeriod };
  }

  const historical = historicalBoundaryCue(value)
    || allTimeCue(value)
    || (records && aggregate)
    || (income && expense && /\bquanto\b/.test(value) && /\b(?:ja|tudo|geral|acumulad\w*)\b/.test(value));

  if (historical) return { flow, scope: 'all_time', periodCanonical: null };
  return { flow, scope: 'period', periodCanonical: 'hoje' };
}

export function isCashAllTimeTotalsRequest(input: string): boolean {
  return parseCashAggregateIntent(input)?.scope === 'all_time';
}
