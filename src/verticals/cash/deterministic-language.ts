import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashBroadHandler } from './broad-handler.js';
import { handleCashPocketCommand } from './cofrinhos.js';
import { cashConversationHandler } from './conversation.js';
import { cashHelpMessage, cashHelpSection } from './help.js';
import { handleCashLedgerDeterministic } from './ledger.js';
import { matchCashNaturalLanguageExample } from './natural-language-corpus.js';
import { matchCashNaturalLanguageExpandedExample } from './natural-language-corpus-expanded.js';
import { matchCashNaturalLanguageColloquialExample } from './natural-language-corpus-colloquial.js';
import { cashQuery } from './query.js';
import { handleCashScheduleDeterministic } from './schedules.js';

export type CashDeterministicLanguageIntent =
  | 'balance'
  | 'projection'
  | 'schedule'
  | 'query'
  | 'history'
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
    .replace(/\s+(?:por favor|pfv)$/g, '')
    .replace(/[!?.,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';

function queryPeriod(value: string): string {
  if (/\bontem\b/.test(value)) return 'ontem';
  if (/\banteontem\b/.test(value)) return 'anteontem';
  if (/\bhoje\b/.test(value)) return 'hoje';
  if (/\b(?:este|esse|deste|desse) mes\b|\bmes atual\b/.test(value)) return 'este mês';
  if (/\bmes passado\b|\bultimo mes\b/.test(value)) return 'mês passado';
  if (/\bsemana passada\b|\bultima semana\b/.test(value)) return 'semana passada';
  if (/\b(?:esta|essa|desta|dessa) semana\b|\bsemana atual\b/.test(value)) return 'esta semana';
  if (/\b(?:este|esse) ano\b|\bano atual\b/.test(value)) return 'este ano';
  if (/\bano passado\b|\bultimo ano\b/.test(value)) return 'ano passado';

  const lastDays = value.match(/\bultimos?\s+(\d{1,3})\s+dias?\b/);
  if (lastDays?.[1]) return `últimos ${lastDays[1]} dias`;

  const month = value.match(new RegExp(`\\b(${MONTHS})(?:\\s+de\\s+(20\\d{2}))?\\b`));
  if (month?.[1]) {
    const name = month[1] === 'marco' ? 'março' : month[1];
    return month[2] ? `${name} de ${month[2]}` : name;
  }

  return 'hoje';
}

function firstMoney(value: string): string | null {
  const match = value.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/);
  return match?.[1] ?? null;
}

function projectionCanonical(input: string, value: string): string | null {
  const base = value.match(/\b(?:considera|considere|usa|use|partindo de|com)\s+(?:um\s+)?saldo\s+(?:de\s+)?(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/)?.[1]
    ?? value.match(/\bsaldo\s+(?:de|igual a)\s*(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/)?.[1];
  const expense = value.match(/\b(?:tira|tiro|retira|desconta|gasto|gastar|gastando|pago|pagar|pagando|sai|sair|saindo)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/)?.[1];
  const income = value.match(/\b(?:recebo|receber|recebendo|ganho|ganhar|ganhando|entra|entrar|entrando)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/)?.[1];

  if (base && expense) return `saldo de ${base} menos ${expense} quanto fica?`;
  if (base && income) return `saldo de ${base} mais ${income} quanto fica?`;

  const simulation = /\b(?:simulacao|simula|so calcula|apenas calcula|sem registrar|nao registra)\w*/.test(value);
  if (simulation && expense) return `se eu gastar ${expense} quanto sobra?`;
  if (simulation && income) return `se eu receber ${income} quanto fica meu saldo?`;

  if (/\b(?:se|e se)\b/.test(value) && firstMoney(value)) return input;
  return null;
}

function scheduleCanonical(input: string, value: string): string | null {
  const monthly = value.match(/\bdia\s+(\d{1,2})\s+de\s+cada\s+mes\b/);
  if (monthly?.[1]) {
    return input.replace(/\bdia\s+\d{1,2}\s+de\s+cada\s+m[eê]s\b/i, `todo mês dia ${monthly[1]}`);
  }
  return null;
}

function aggregateQueryCanonical(value: string): string | null {
  const aggregation = /\b(?:soma|some|somar|somando|total|totaliza|totalizar|totalizando|valor total|ao todo|no total|quanto deu|quanto foi|quanto ficou|fechamento|fecha|feche|balanco|resumo)\b/.test(value);
  const asksHowMuch = /\bquanto\b/.test(value) && /\b(?:ganh\w*|gast\w*|receb\w*|pag\w*|entr\w*|sai\w*|despes\w*|receit\w*)\b/.test(value);
  if (!aggregation && !asksHowMuch) return null;

  const income = /\b(?:ganhei|ganho|ganhos|recebi|recebido|recebimentos?|receitas?|entradas?|entrou|entraram|caiu|vendi|vendas?|faturei|faturamento)\b/.test(value);
  const expense = /\b(?:gastei|gasto|gastos|despesas?|saidas?|saiu|sairam|paguei|pagamentos?|comprei|compras?)\b/.test(value);
  const records = /\b(?:lancamentos?|registros?|movimentacoes?)\b/.test(value);
  if (!income && !expense && !records) return null;

  const period = queryPeriod(value);
  if ((income && expense) || (records && !income && !expense)) return `quanto entrou e quanto saiu ${period}?`;
  if (expense) return `quanto gastei ${period}?`;
  if (income) return `quanto recebi ${period}?`;
  return null;
}

export function classifyCashDeterministicLanguage(input: string): CashDeterministicLanguageRoute {
  const value = normalize(input);
  if (!value) return null;

  if (/\b(?:ainda\s+)?(?:vou|irei)\s+(?:enviar|mandar|passar|informar)\b/.test(value)
    && /\b(devendo|deve|caixa|saldo|vendas?|gastos?|informacoes?)\b/.test(value)) {
    return { intent: 'future_data', canonical: input };
  }

  // As camadas de corpus entram cedo para remover linguagem conversacional e
  // entregar ao motor financeiro apenas a intenção e a frase canônica seguras.
  const expandedCorpus = matchCashNaturalLanguageExpandedExample(input);
  if (expandedCorpus) return { intent: expandedCorpus.intent, canonical: expandedCorpus.canonical };

  const colloquialCorpus = matchCashNaturalLanguageColloquialExample(input);
  if (colloquialCorpus) return { intent: colloquialCorpus.intent, canonical: colloquialCorpus.canonical };

  const schedule = scheduleCanonical(input, value);
  if (schedule) return { intent: 'schedule', canonical: schedule };

  const projection = projectionCanonical(input, value);
  if (projection) return { intent: 'projection', canonical: projection };

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

  const aggregate = aggregateQueryCanonical(value);
  if (aggregate) return { intent: 'query', canonical: aggregate };

  const corpus = matchCashNaturalLanguageExample(input);
  if (corpus) return { intent: corpus.intent, canonical: corpus.canonical };

  if (/^(?:(?:me )?(?:diz|fala|mostra|mostre)\s+)?(?:o\s+)?(?:meu\s+)?(?:saldo|saldo atual|saldo disponivel|balanco)(?:\s+(?:agora|hoje))?$/.test(value)
    || /\b(?:quanto eu tenho|quanto tenho|quanto que eu tenho|quanto sobrou|quanto me resta|quanto tenho de dinheiro|quanto tenho disponivel|qual e meu saldo|me fala meu saldo atual|quanto ficou meu saldo)\b/.test(value)) {
    return { intent: 'balance', canonical: 'saldo' };
  }

  if (/^(?:(?:me )?(?:fala|mostra|mostre|lista|liste|traz|traga)\s+)?(?:os\s+)?(?:meus\s+)?(?:registros|registos|lancamentos|movimentacoes)$/.test(value)
    || /^(?:quais|qual)\s+(?:sao\s+)?(?:os\s+)?(?:meus\s+)?(?:registros|registos|lancamentos|movimentacoes)$/.test(value)) {
    return { intent: 'history', canonical: 'histórico' };
  }

  if (/\b(?:me mostra|mostra|mostre)\s+(?:os\s+|as\s+)?(?:tudo\s+que\s+)?(?:entrou|recebimentos?)\b/.test(value)
    || /\bquanto foi de entrada\b/.test(value)) {
    return { intent: 'query', canonical: `quanto recebi ${queryPeriod(value)}?` };
  }

  if (/\b(?:me mostra|mostra|mostre)\s+(?:os\s+|as\s+)?(?:tudo\s+que\s+)?saiu\b/.test(value)) {
    return { intent: 'query', canonical: `quanto gastei ${queryPeriod(value)}?` };
  }

  if (/\bcompra mais cara\b/.test(value)) {
    return { intent: 'query', canonical: `qual foi meu maior gasto ${queryPeriod(value)}?` };
  }

  if (/\b(?:coloca|bota|poe)(?:\s+(?:ele|ela|isso|o registro|o lancamento))?\s+(?:de novo|novamente)\b/.test(value)) {
    return { intent: 'undo', canonical: 'coloca ele de novo' };
  }

  if (/\b(ajuda|menu|comandos|como usar|como usa|o que voce faz|me ensina|tutorial)\b/.test(value)) {
    return { intent: 'help', canonical: input };
  }

  return null;
}

export async function handleCashDeterministicLanguage(context: VerticalContext): Promise<VerticalResult | null> {
  const route = classifyCashDeterministicLanguage(context.combinedText);
  if (!route) return null;

  if (route.intent === 'future_data') {
    return text('Perfeito. Pode me mandar quem está devendo, os valores e quanto tem no caixa. Vou separar saldo, retiradas e valores a receber sem registrar número solto como despesa.');
  }

  if (route.intent === 'balance' || route.intent === 'projection') {
    return await handleCashLedgerDeterministic({ ...context, combinedText: route.canonical });
  }

  if (route.intent === 'schedule') {
    return await handleCashScheduleDeterministic({ ...context, combinedText: route.canonical });
  }

  if (route.intent === 'query') {
    return await cashQuery.handle(context.company.id, route.canonical);
  }

  if (route.intent === 'history' || route.intent === 'undo') {
    return await cashConversationHandler.handle({ ...context, combinedText: route.canonical });
  }

  if (route.intent === 'help') {
    const section = cashHelpSection(context.combinedText) ?? 'menu';
    return text(cashHelpMessage(section));
  }

  if (route.intent === 'plans' || route.intent === 'trial' || route.intent === 'categories') {
    return await cashBroadHandler.handle({ ...context, combinedText: route.canonical });
  }

  if (route.intent === 'pocket') {
    return await handleCashPocketCommand({ ...context, combinedText: route.canonical });
  }

  return null;
}
