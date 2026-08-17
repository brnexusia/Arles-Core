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

export function hasCashExplicitAggregatePeriod(input: string): boolean {
  const value = normalize(input);
  if (!value) return false;

  return /\b(?:hoje|ontem|anteontem|amanha)\b/.test(value)
    || /\b(?:esta|essa|desta|desse|ultima|ultimo|passada|passado|atual)\s+(?:semana|mes|ano)\b/.test(value)
    || /\b(?:semana|mes|ano)\s+(?:passada|passado|atual)\b/.test(value)
    || /\b(?:nesta|nesse|naquela|naquele)\s+(?:semana|mes|ano)\b/.test(value)
    || /\b(?:ultimos?|ultimas?)\s+\d{1,3}\s+dias?\b/.test(value)
    || new RegExp(`\\b(?:em\\s+)?(?:${MONTHS})(?:\\s+de\\s+20\\d{2})?\\b`).test(value)
    || /\b(?:dia\s+)?\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(value)
    || /\b(?:entre|de)\s+(?:o\s+)?dia\s*\d{1,2}\b/.test(value)
    || /\b(?:do|desse|deste|no|nesse|neste)\s+mes\b/.test(value)
    || /\b(?:da|dessa|desta|na|nessa|nesta)\s+semana\b/.test(value)
    || /\b(?:do|desse|deste|no|nesse|neste)\s+ano\b/.test(value);
}

function historicalBoundaryCue(value: string): boolean {
  return /\b(?:desde o inicio|desde que comecei|desde sempre|ate agora|ate hoje|vida toda)\b/.test(value);
}

function allTimeCue(value: string): boolean {
  return /\b(?:total geral|geral|global|acumulad\w*|historico completo|historico todo|todo o historico|desde o inicio|desde que comecei|desde sempre|ate agora|ate hoje|no geral|ao todo|de tudo|tudo que|tudo o que|todos? os lancamentos|todos? os registros|todas? as movimentacoes|vida toda)\b/.test(value);
}

function aggregateCue(value: string): boolean {
  return /\b(?:soma|some|somar|somando|total|totaliza|totalizar|totalizando|valor total|valor acumulado|acumulado|balanco|fechamento|quanto deu|quanto ficou|quanto foi|quanto ja|ao todo|no total)\b/.test(value);
}

function incomeCue(value: string): boolean {
  return /\b(?:ganhei|ganho|ganhos|recebi|recebido|recebimentos?|receitas?|entradas?|entrou|entraram|caiu|cairam|vendi|vendas?|faturei|faturamento|dinheiro que entrou|o que entrou)\b/.test(value);
}

function expenseCue(value: string): boolean {
  return /\b(?:gastei|gasto|gastos|despesas?|saidas?|saiu|sairam|paguei|pagamentos?|comprei|compras?|dinheiro que saiu|o que saiu)\b/.test(value);
}

function recordCue(value: string): boolean {
  return /\b(?:lancamentos?|registros?|movimentacoes?|historico)\b/.test(value);
}

/**
 * Reconhece pedidos de totais acumulados sem depender de uma frase exata.
 * Períodos explícitos ganham prioridade: “total de hoje” continua sendo consulta de hoje.
 */
export function isCashAllTimeTotalsRequest(input: string): boolean {
  const value = normalize(input);
  if (!value || /\b(?:cofrinh|caixinh|envelope|potinh|pote)\w*/.test(value)) return false;

  const income = incomeCue(value);
  const expense = expenseCue(value);
  const records = recordCue(value);
  const aggregate = aggregateCue(value);
  const allTime = allTimeCue(value);
  const explicitPeriod = hasCashExplicitAggregatePeriod(value);
  const historicalBoundary = historicalBoundaryCue(value);

  // “total de tudo hoje / neste mês” ainda é daquele período; “até hoje” é histórico.
  if (explicitPeriod && !historicalBoundary) return false;

  if (allTime && (aggregate || income || expense || records || /\bsaldo\b/.test(value))) return true;
  if (!explicitPeriod && aggregate && income && expense) return true;
  if (!explicitPeriod && aggregate && records) return true;
  if (!explicitPeriod && income && expense && /\bquanto\b/.test(value) && /\b(?:ja|tudo|geral|acumulado)\b/.test(value)) return true;

  return false;
}
