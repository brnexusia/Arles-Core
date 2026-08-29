import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashBroadHandler } from './broad-handler.js';
import { handleCashPocketCommand } from './cofrinhos.js';
import { stageCashRegistration } from './confirmation.js';
import { cashConversationHandler } from './conversation.js';
import { rememberCashQueryContext } from './conversation-state.js';
import {
  cashFinancialIntentAudit,
  interpretCashFinancialIntent,
  type CashFinancialIntent
} from './financial-intent.js';
import { executeCashFinancialSummary } from './financial-summary.js';
import { cashHelpMessage, cashHelpSection } from './help.js';
import {
  clearCashFinancialIntentContext,
  expandCashFinancialIntentFollowup,
  getCashFinancialIntentContext,
  rememberCashFinancialIntentContext
} from './intent-context.js';
import { handleCashLedgerDeterministic } from './ledger.js';
import { matchCashNaturalLanguageAnyExample } from './natural-language-corpus-doubled.js';
import { executeCashProjection } from './projection-executor.js';
import { deterministicCashQuery } from './query.js';
import { executeCashQueryFilters } from './query-filter-executor.js';
import { executeCashRecentBatchReference } from './recent-batch.js';
import { handleCashScheduleDeterministic } from './schedules.js';

export type CashDeterministicLanguageIntent =
  | 'balance'
  | 'aggregate'
  | 'projection'
  | 'schedule'
  | 'query'
  | 'history'
  | 'transaction'
  | 'recent_batch'
  | 'help'
  | 'plans'
  | 'trial'
  | 'categories'
  | 'pocket'
  | 'undo'
  | 'future_data';

export type CashDeterministicLanguageRoute = {
  intent: CashDeterministicLanguageIntent;
  canonical: string;
} | null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[!?.,]+$/g, '')
    .replace(/\s+(?:por favor|pfv)$/g, '')
    .replace(/\s+(?:pra mim|para mim)$/g, '')
    .replace(/[!?.,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scheduleCanonical(input: string, value: string): string | null {
  const monthly = value.match(/\bdia\s+(\d{1,2})\s+de\s+cada\s+mes\b/);
  if (monthly?.[1]) {
    return input.replace(/\bdia\s+\d{1,2}\s+de\s+cada\s+m[eê]s\b/i, `todo mês dia ${monthly[1]}`);
  }
  return null;
}

function mapCentralIntent(intent: CashFinancialIntent): CashDeterministicLanguageRoute {
  return { intent: intent.kind, canonical: intent.canonical };
}

function corpusRoute(input: string): CashDeterministicLanguageRoute {
  const corpus = matchCashNaturalLanguageAnyExample(input);
  return corpus ? { intent: corpus.intent, canonical: corpus.canonical } : null;
}

function hasStrongAggregateLanguage(value: string): boolean {
  return /\b(?:soma|some|somar|somando|total|totaliza|totalize|totalizar|valor total|valor acumulado|acumulado|balanco|fechamento|resumo|quanto deu|quanto ficou|quanto foi|ao todo|no total)\b/.test(value);
}

function hasCombinedFlowAggregateQuestion(value: string): boolean {
  if (!/\bquanto\b/.test(value)) return false;
  const income = /\b(?:ganhei|ganho|ganhos|recebi|recebido|recebimentos?|receitas?|entradas?|entrou|entraram|vendi|vendas?|faturei|faturamento|renda|salario)\b/.test(value);
  const expense = /\b(?:gastei|gasto|gastos|despesas?|saidas?|saiu|sairam|paguei|pagamentos?|comprei|compras?|custos?)\b/.test(value);
  return income && expense;
}

export function classifyCashDeterministicLanguage(input: string): CashDeterministicLanguageRoute {
  const value = normalize(input);
  if (!value) return null;

  const schedule = scheduleCanonical(input, value);
  if (schedule) return { intent: 'schedule', canonical: schedule };

  if (/\b(trial|teste gratis|periodo gratuito|dias gratis)\b/.test(value)) {
    return { intent: 'trial', canonical: 'trial' };
  }

  if (/\b(plano|planos|preco|assinar|assinatura|quanto custa)\b/.test(value)
    || /\bcomo\s+pag(?:o|ar)\s+(?:o\s+)?(?:arles\s+)?cash\b/.test(value)) {
    return { intent: 'plans', canonical: 'planos' };
  }

  if (/\b(categorias|categoria automatica|como categoriza|classifica meus gastos|classifica minhas despesas)\b/.test(value)) {
    return { intent: 'categories', canonical: 'categorias' };
  }

  if (/\b(cofrinh(?:o|os)|caixinh(?:a|as)|envelopes?|potinh(?:o|os)|potes?)\b/.test(value)) {
    return { intent: 'pocket', canonical: input };
  }

  if (/\b(?:coloca|bota|poe)(?:\s+(?:ele|ela|isso|o registro|o lancamento))?\s+(?:de novo|novamente)\b/.test(value)) {
    return { intent: 'undo', canonical: 'coloca ele de novo' };
  }

  // Compatibility fast path: known, simple scoped questions preserve their
  // established query route. Explicit totals and combined income+expense
  // questions still go through the central aggregate interpreter.
  const legacy = corpusRoute(input);
  const shouldPromoteAggregate = hasStrongAggregateLanguage(value) || hasCombinedFlowAggregateQuestion(value);
  if (legacy && !shouldPromoteAggregate) return legacy;

  // Some established scoped questions are parsed deterministically even when
  // they are not exact corpus entries (for example, "quanto gastei hoje?").
  // Keep those as detailed queries unless the user explicitly asks for a total
  // or combines income + expense in the same aggregate question.
  if (!shouldPromoteAggregate && deterministicCashQuery(input)) {
    return { intent: 'query', canonical: input };
  }

  const central = interpretCashFinancialIntent(input);
  if (central?.kind === 'aggregate') return mapCentralIntent(central);

  if (legacy) return legacy;
  if (central) return mapCentralIntent(central);

  // Generic help is intentionally last: "me ajuda a conferir quanto gastei"
  // is a financial query, not a request for the help menu.
  if (/\b(ajuda|menu|comandos|como usar|como usa|o que voce faz|me ensina|tutorial)\b/.test(value)) {
    return { intent: 'help', canonical: input };
  }

  return null;
}

function periodClarification(intent: CashFinancialIntent): VerticalResult {
  const subject = intent.flow === 'income'
    ? 'receitas/entradas'
    : intent.flow === 'expense'
      ? 'gastos/saídas'
      : 'lançamentos';
  return text([
    `Entendi que você quer consultar ${subject}, mas o período ficou aberto.`,
    'Para não assumir “hoje” e te dar um número errado, me diga o período.',
    '',
    'Exemplos:',
    '• “hoje”',
    '• “este mês”',
    '• “mês passado”',
    '• “no total / desde o início”'
  ].join('\n'));
}

async function handleCentralFinancialIntent(
  context: VerticalContext,
  intent: CashFinancialIntent
): Promise<VerticalResult | null> {
  console.info(`[CashIntent] company=${context.company.id} ${cashFinancialIntentAudit(intent)}`);

  if (intent.needsClarification === 'period') return periodClarification(intent);

  if (intent.kind === 'future_data') {
    await clearCashFinancialIntentContext(context.company.id, context.message.phone);
    return text('Perfeito. Pode me mandar quem está devendo, os valores e quanto tem no caixa. Vou separar saldo, retiradas e valores a receber sem registrar número solto como despesa.');
  }

  if (intent.kind === 'recent_batch') {
    const recentIntent = intent.operation === 'sum' ? 'aggregate' : 'summary';
    const result = await executeCashRecentBatchReference(context, recentIntent);
    return result ?? text('Não encontrei um envio financeiro confirmado recente para usar como base. Confirme os lançamentos primeiro e depois peça o cálculo do último envio.');
  }

  if (intent.kind === 'aggregate' && intent.aggregate) {
    return await executeCashFinancialSummary(context, intent.aggregate);
  }

  if (intent.kind === 'balance') {
    return await handleCashLedgerDeterministic({ ...context, combinedText: 'saldo' });
  }

  if (intent.kind === 'projection' && intent.projection) {
    return await executeCashProjection(context, intent.projection);
  }

  if (intent.kind === 'query' && intent.query) {
    const result = await executeCashQueryFilters(context.company.id, intent.query);
    await rememberCashQueryContext(context.company.id, context.message.phone, intent.canonical);
    return result;
  }

  if (intent.kind === 'history') {
    return await cashConversationHandler.handle({ ...context, combinedText: 'histórico' });
  }

  if (intent.kind === 'transaction' && intent.transaction) {
    await clearCashFinancialIntentContext(context.company.id, context.message.phone);
    return await stageCashRegistration(context, [intent.transaction], context.combinedText);
  }

  return null;
}

export async function handleCashDeterministicLanguage(context: VerticalContext): Promise<VerticalResult | null> {
  const previous = await getCashFinancialIntentContext(context.company.id, context.message.phone);
  const expanded = previous
    ? expandCashFinancialIntentFollowup(previous, context.combinedText)
    : null;
  const effectiveContext = expanded
    ? { ...context, combinedText: expanded }
    : context;

  if (expanded) {
    console.info(`[CashIntent] context-followup company=${context.company.id} expanded=${JSON.stringify(expanded)}`);
  }

  const central = interpretCashFinancialIntent(effectiveContext.combinedText);
  if (central) {
    const result = await handleCentralFinancialIntent(effectiveContext, central);
    if (result) {
      await rememberCashFinancialIntentContext(context.company.id, context.message.phone, central);
      return result;
    }
  }

  const route = classifyCashDeterministicLanguage(effectiveContext.combinedText);
  if (!route) return null;

  if (route.intent === 'schedule') {
    return await handleCashScheduleDeterministic({ ...effectiveContext, combinedText: route.canonical });
  }

  if (route.intent === 'history' || route.intent === 'undo') {
    return await cashConversationHandler.handle({ ...effectiveContext, combinedText: route.canonical });
  }

  if (route.intent === 'help') {
    const section = cashHelpSection(effectiveContext.combinedText) ?? 'menu';
    return text(cashHelpMessage(section));
  }

  if (route.intent === 'plans' || route.intent === 'trial' || route.intent === 'categories') {
    return await cashBroadHandler.handle({ ...effectiveContext, combinedText: route.canonical });
  }

  if (route.intent === 'pocket') {
    return await handleCashPocketCommand({ ...effectiveContext, combinedText: route.canonical });
  }

  return null;
}
