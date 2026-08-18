import type { CashAggregateIntent } from './aggregate-intent.js';
import { parseCashAggregateIntent } from './aggregate-intent.js';
import { deterministicCashParse } from './parser.js';
import { deterministicCashQuery, type CashQueryFilters } from './query.js';
import type { CashTransactionInput } from './types.js';

export type CashFinancialIntentKind =
  | 'aggregate'
  | 'balance'
  | 'query'
  | 'history'
  | 'transaction'
  | 'projection'
  | 'recent_batch'
  | 'future_data';

export type CashFinancialReference = 'recent_batch' | null;
export type CashFinancialConfidence = 'high' | 'medium';

export interface CashFinancialIntent {
  kind: CashFinancialIntentKind;
  operation: 'sum' | 'read' | 'list' | 'register' | 'simulate' | 'wait';
  flow: 'income' | 'expense' | 'both' | 'all' | null;
  scope: 'all_time' | 'period' | 'recent_batch' | 'unspecified' | 'none';
  periodCanonical: string | null;
  reference: CashFinancialReference;
  mutation: boolean;
  confidence: CashFinancialConfidence;
  needsClarification: 'period' | null;
  canonical: string;
  aggregate?: CashAggregateIntent;
  query?: CashQueryFilters;
  transaction?: CashTransactionInput;
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ');
}

const MONTHS = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';

export function hasCashExplicitFinancialPeriod(input: string): boolean {
  const value = normalize(input);
  if (!value) return false;
  if (/\b(?:hoje|ontem|anteontem)\b/.test(value)) return true;
  if (/\b(?:esta|essa|nesta|nessa|desta|dessa|ultima|passada|atual) semana\b|\bsemana (?:passada|atual)\b/.test(value)) return true;
  if (/\b(?:este|esse|neste|nesse|deste|desse|ultimo|passado|atual) mes\b|\bmes (?:passado|atual)\b/.test(value)) return true;
  if (/\b(?:este|esse|neste|nesse|deste|desse|ultimo|passado|atual) ano\b|\bano (?:passado|atual)\b/.test(value)) return true;
  if (/\bultim(?:os|as)\s+\d{1,3}\s+dias?\b/.test(value)) return true;
  if (new RegExp(`\\b(?:${MONTHS})(?:\\s+de\\s+20\\d{2})?\\b`).test(value)) return true;
  if (/\b(?:entre|de)\s+\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\s+(?:e|ate|a)\s+\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(value)) return true;
  if (/\b(?:dia\s*)?\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(value)) return true;
  if (/\bdia\s+\d{1,2}\b/.test(value)) return true;
  return false;
}

function destructive(value: string): boolean {
  return /\b(?:apaga|apagar|exclui|excluir|remove|remover|deleta|deletar|cancela|cancelar|edita|editar|corrige|corrigir|altera|alterar|muda|mudar)\b/.test(value);
}

function recentBatchReference(value: string): boolean {
  if (/\b(?:ultimo|ultima|ultimos|ultimas)\s+(?:mes|semana|ano|dia|dias)\b/.test(value)) return false;
  return /\b(?:ultimo|ultima|mais recente)\s+(?:envio|mensagem|lote|dados?|informacoes?|lancamento|registro)\b/.test(value)
    || /\b(?:nesse|neste|desse|deste)\s+ultimo\s+(?:envio|lote|lancamento|registro)\b/.test(value)
    || /\bmais recente\s+que\s+(?:eu\s+)?(?:mandei|enviei|passei|informei)\b/.test(value)
    || /\b(?:o que|isso que|dados que|informacoes que)\s+(?:eu\s+)?acabei\s+de\s+(?:mandar|enviar|passar|informar)\b/.test(value)
    || /\b(?:ultimo|ultima)\s+coisa\s+que\s+(?:eu\s+)?(?:mandei|enviei|passei)\b/.test(value);
}

function recentBatchOperation(value: string): 'sum' | 'read' {
  const financial = /\b(?:ganhei|ganho|ganhos|recebi|receitas?|entradas?|entrou|vendi|vendas?|faturei|gastei|gasto|gastos|despesas?|saidas?|saiu|paguei|comprei)\b/.test(value);
  const calculation = /\b(?:calculo|calcula|calcule|calcular|soma|some|somar|total|totaliza|quanto|balanco|resumo|resultado)\b/.test(value);
  return financial || calculation ? 'sum' : 'read';
}

function directBalance(value: string): boolean {
  return /^(?:(?:me )?(?:diz|fala|mostra|mostre)\s+)?(?:o\s+)?(?:meu\s+)?(?:saldo|saldo atual|saldo disponivel|balanco)(?:\s+(?:agora|hoje))?$/.test(value)
    || /\b(?:quanto eu tenho|quanto tenho|quanto que eu tenho|quanto sobrou|quanto me resta|quanto tenho de dinheiro|quanto tenho disponivel|qual e meu saldo|quanto ficou meu saldo)\b/.test(value);
}

function directHistory(value: string): boolean {
  return /^(?:(?:me )?(?:fala|mostra|mostre|lista|liste|traz|traga)\s+)?(?:os\s+)?(?:meus\s+)?(?:registros|registos|lancamentos|movimentacoes)$/.test(value)
    || /^(?:quais|qual)\s+(?:sao\s+)?(?:os\s+)?(?:meus\s+)?(?:registros|registos|lancamentos|movimentacoes)$/.test(value)
    || /^(?:historico|ultimos registros|ultimos lancamentos)$/.test(value);
}

function projection(value: string): boolean {
  return /\b(?:se eu|e se|simula|simular|simulacao|so calcula|apenas calcula|sem registrar|nao registra)\b/.test(value)
    && /\b(?:gast\w*|pag\w*|compr\w*|receb\w*|ganh\w*|entr\w*|sai\w*|saldo|sobr\w*|fic\w*)\b/.test(value);
}

function futureData(value: string): boolean {
  return /\b(?:ainda\s+)?(?:vou|irei)\s+(?:enviar|mandar|passar|informar)\b/.test(value)
    && /\b(devendo|deve|caixa|saldo|vendas?|gastos?|informacoes?)\b/.test(value);
}

function canonicalAggregate(intent: CashAggregateIntent): string {
  if (intent.scope === 'all_time') {
    if (intent.flow === 'income') return 'total geral de todas as receitas';
    if (intent.flow === 'expense') return 'total geral de todas as despesas';
    return 'total geral de todas as entradas e saídas';
  }
  const period = intent.periodCanonical || 'hoje';
  if (intent.flow === 'income') return `quanto recebi ${period}?`;
  if (intent.flow === 'expense') return `quanto gastei ${period}?`;
  return `quanto entrou e quanto saiu ${period}?`;
}

export function canonicalCashQueryFromFilters(filters: CashQueryFilters): string {
  let base: string;
  if (filters.sort === 'amount_desc' && filters.type === 'expense') base = 'qual foi meu maior gasto';
  else if (filters.sort === 'amount_asc' && filters.type === 'expense') base = 'qual foi meu menor gasto';
  else if (filters.type === 'income') base = filters.compact ? 'mostra minhas receitas' : 'quanto recebi';
  else if (filters.type === 'expense') base = filters.compact ? 'mostra meus gastos' : 'quanto gastei';
  else base = 'mostra meus registros';

  if (filters.term) base += ` com ${filters.term}`;
  if (filters.category) base += ` em ${filters.category}`;
  if (filters.minAmount != null && filters.maxAmount != null) base += ` entre ${filters.minAmount} e ${filters.maxAmount}`;
  else if (filters.minAmount != null) base += ` acima de ${filters.minAmount}`;
  else if (filters.maxAmount != null) base += ` abaixo de ${filters.maxAmount}`;
  base += ` ${filters.periodLabel}`;
  return base.trim();
}

export function interpretCashFinancialIntent(input: string): CashFinancialIntent | null {
  const original = String(input ?? '').trim();
  const value = normalize(original);
  if (!value) return null;

  // Gestão destrutiva tem um fluxo próprio com confirmação/segurança. O interpretador
  // financeiro nunca sequestra "apaga/edita o último lançamento" como leitura.
  if (destructive(value)) return null;

  if (futureData(value)) {
    return {
      kind: 'future_data', operation: 'wait', flow: null, scope: 'none', periodCanonical: null,
      reference: null, mutation: false, confidence: 'high', needsClarification: null, canonical: original
    };
  }

  if (recentBatchReference(value)) {
    return {
      kind: 'recent_batch', operation: recentBatchOperation(value), flow: 'both', scope: 'recent_batch', periodCanonical: null,
      reference: 'recent_batch', mutation: false, confidence: 'high', needsClarification: null, canonical: original
    };
  }

  const aggregate = parseCashAggregateIntent(original);
  if (aggregate) {
    const explicit = hasCashExplicitFinancialPeriod(original);
    const ambiguousImplicitToday = aggregate.scope === 'period' && aggregate.periodCanonical === 'hoje' && !explicit;
    return {
      kind: 'aggregate', operation: 'sum', flow: aggregate.flow, scope: ambiguousImplicitToday ? 'unspecified' : aggregate.scope,
      periodCanonical: ambiguousImplicitToday ? null : aggregate.periodCanonical,
      reference: null, mutation: false, confidence: 'high', needsClarification: ambiguousImplicitToday ? 'period' : null,
      canonical: canonicalAggregate(aggregate), aggregate
    };
  }

  if (directBalance(value)) {
    return {
      kind: 'balance', operation: 'read', flow: 'both', scope: 'all_time', periodCanonical: null,
      reference: null, mutation: false, confidence: 'high', needsClarification: null, canonical: 'saldo'
    };
  }

  if (projection(value)) {
    return {
      kind: 'projection', operation: 'simulate', flow: null, scope: 'none', periodCanonical: null,
      reference: null, mutation: false, confidence: 'high', needsClarification: null, canonical: original
    };
  }

  if (directHistory(value)) {
    return {
      kind: 'history', operation: 'list', flow: 'all', scope: 'none', periodCanonical: null,
      reference: null, mutation: false, confidence: 'high', needsClarification: null, canonical: 'histórico'
    };
  }

  const query = deterministicCashQuery(original);
  if (query) {
    const explicit = hasCashExplicitFinancialPeriod(original);
    return {
      kind: 'query', operation: query.compact ? 'list' : 'read', flow: query.type === 'all' ? 'all' : query.type,
      scope: explicit ? 'period' : 'unspecified', periodCanonical: explicit ? query.periodLabel : null,
      reference: null, mutation: false, confidence: 'high', needsClarification: explicit ? null : 'period',
      canonical: canonicalCashQueryFromFilters(query), query
    };
  }

  const transaction = deterministicCashParse(original);
  if (transaction) {
    return {
      kind: 'transaction', operation: 'register', flow: transaction.type, scope: 'none', periodCanonical: transaction.transactionDate,
      reference: null, mutation: true, confidence: 'high', needsClarification: null, canonical: original, transaction
    };
  }

  return null;
}

export function cashFinancialIntentAudit(intent: CashFinancialIntent): string {
  const parts = [
    `kind=${intent.kind}`,
    `operation=${intent.operation}`,
    `flow=${intent.flow ?? 'none'}`,
    `scope=${intent.scope}`,
    `period=${intent.periodCanonical ?? 'none'}`,
    `reference=${intent.reference ?? 'none'}`,
    `mutation=${intent.mutation ? 'yes' : 'no'}`,
    `clarify=${intent.needsClarification ?? 'no'}`
  ];
  return parts.join(' ');
}
