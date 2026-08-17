import type { VerticalContext, VerticalResult } from '../vertical.js';
import { handleCashPocketCommand } from './cofrinhos.js';
import { stageCashRegistration } from './confirmation.js';
import { cashConversationHandler } from './conversation.js';
import { cashHelpMessage, cashHelpSection } from './help.js';
import { isCashProtectedNonTransaction } from './ledger.js';
import { deterministicCashParse } from './parser.js';
import { cashQuery, deterministicCashQuery } from './query.js';
import { handleCashScheduleDeterministic } from './schedules.js';
import type { CashTransactionInput } from './types.js';

export type CashCorpusIntent =
  | 'greeting'
  | 'acknowledgement'
  | 'transaction'
  | 'batch_transaction'
  | 'query'
  | 'history'
  | 'balance'
  | 'projection'
  | 'pocket'
  | 'schedule'
  | 'weekly_report'
  | 'monthly_report'
  | 'edit'
  | 'delete'
  | 'undo'
  | 'help'
  | 'plans'
  | 'trial'
  | 'categories'
  | 'unknown';

export interface CashCorpusRoute {
  intent: CashCorpusIntent;
  confidence: 'high' | 'medium';
  canonical?: string;
}

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

export function normalizeCashCorpusText(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function explicitMovement(value: string): boolean {
  return /\b(gastei|gasto|paguei|pague|comprei|custou|saiu|debitei|recebi|ganhei|entrou|vendi|faturei|depositaram|guardei|reservei|separei)\b/.test(value);
}

function hasMoney(value: string): boolean {
  return /(?:r\$\s*)?\d+(?:\.\d{3})*(?:[.,]\d{1,2})?/.test(value);
}

function looksBatch(input: string): boolean {
  const value = normalizeCashCorpusText(input);
  const amounts = input.match(/(?:r\$\s*)?\d+(?:\.\d{3})*(?:[.,]\d{1,2})?/gi) ?? [];
  if (amounts.length < 2) return false;
  if (/\b(se|caso|e se|quanto|saldo|simula|calcula)\b/.test(value)) return false;
  const movements = value.match(/\b(gastei|paguei|comprei|recebi|ganhei|entrou|vendi|faturei|guardei|reservei|separei)\b/g) ?? [];
  return movements.length >= 2
    || /\n|;/.test(input)
    || /\b(despesas|gastos|saidas|entradas|receitas|ganhos)\s*:/.test(value);
}

function pocketSynonymRewrite(input: string): string | null {
  const value = normalizeCashCorpusText(input);
  if (!/\b(caixinha|envelope|potinho|pote|separacao|separação)\b/.test(value)) return null;
  return input
    .replace(/caixinha/gi, 'cofrinho')
    .replace(/envelope/gi, 'cofrinho')
    .replace(/potinho/gi, 'cofrinho')
    .replace(/\bpote\b/gi, 'cofrinho')
    .replace(/separa(?:ç|c)ão/gi, 'cofrinho');
}

export function classifyCashCorpus(input: string): CashCorpusRoute {
  const value = normalizeCashCorpusText(input).replace(/[!?.,]+$/g, '').trim();
  if (!value) return { intent: 'unknown', confidence: 'medium' };

  if (/^(oi+|ola+|opa|e ai|eae|bom dia|boa tarde|boa noite|fala|salve|hey|hello)(?: tudo bem| beleza| cash)?$/.test(value)) {
    return { intent: 'greeting', confidence: 'high' };
  }
  if (/^(ok|okay|certo|beleza|blz|entendi|show|perfeito|valeu|obrigado|obrigada|massa|top|fechou|tranquilo|ta bom|tá bom|show de bola)$/.test(value)) {
    return { intent: 'acknowledgement', confidence: 'high' };
  }

  if (/\b(se|caso|e se|simula|simular|calcula|calcular)\b/.test(value)
    && /\b(?:gast\w*|pag\w*|compr\w*|receb\w*|ganh\w*|entr\w*|sai\w*|saldo|sobr\w*|fic\w*|ter\w*)\b/.test(value)) {
    return { intent: 'projection', confidence: 'high', canonical: input };
  }

  if (looksBatch(input)) return { intent: 'batch_transaction', confidence: 'high', canonical: input };

  if (/\b(agend|program|previst|previs|todo dia|toda semana|todo mes|todo mês|todo ano|mensalmente|semanalmente|diariamente|a cada|contas futuras|saldo projetado|projecao|projeção|quanto vou ter|quanto terei|quanto vai sobrar|quanto vou gastar|quanto vou receber|quanto vou ganhar)\w*/.test(value)) {
    return { intent: 'schedule', confidence: 'high', canonical: input };
  }

  if (/\b(cofrinho|caixinha|envelope|potinho|pote|separacao|separação)\b/.test(value)) {
    return { intent: 'pocket', confidence: 'high', canonical: pocketSynonymRewrite(input) ?? input };
  }

  if (/^(saldo|meu saldo|saldo atual|quanto tenho|quanto eu tenho|quanto sobrou|quanto me resta|qual e meu saldo|qual é meu saldo|como esta meu saldo|como está meu saldo)/.test(value)) {
    return { intent: 'balance', confidence: 'high', canonical: 'saldo' };
  }

  if (/^(historico|histórico|ultimos|últimos|meus registros|o que registrei|meus lancamentos|meus lançamentos)$/.test(value)) {
    return { intent: 'history', confidence: 'high', canonical: 'histórico' };
  }
  if (/\b(relatorio|relatório|resumo|fechamento)\b.*\b(semana|semanal)\b|^como foi a semana$/.test(value)) {
    return { intent: 'weekly_report', confidence: 'high', canonical: 'relatório semanal' };
  }
  if (/\b(relatorio|relatório|resumo|fechamento)\b.*\b(mes|mês|mensal)\b|^como foi o mes$|^como foi o mês$/.test(value)) {
    return { intent: 'monthly_report', confidence: 'high', canonical: 'relatório mensal' };
  }

  if (/\b(desfaz|desfazer|restaura|restaurar|recupera|recuperar|coloca de novo|bota de novo|poe de novo|põe de novo)\b/.test(value)) {
    return { intent: 'undo', confidence: 'high', canonical: 'coloca ele de novo' };
  }
  if (/\b(apaga|apagar|exclui|excluir|remove|remover|retira|retirar|deleta|deletar|cancela ele|cancela esse)\b/.test(value)) {
    return { intent: 'delete', confidence: 'high', canonical: input };
  }
  if (/\b(edita|editar|corrige|corrigir|altera|alterar|muda|mudar|ajusta|ajustar|errei|errado)\b/.test(value)) {
    return { intent: 'edit', confidence: 'high', canonical: input };
  }

  if (/\b(ajuda|menu|comandos|como usar|como funciona|o que voce faz|o que você faz|me ensina|tutorial)\b/.test(value)) {
    return { intent: 'help', confidence: 'high', canonical: input };
  }
  if (/\b(plano|planos|preco|preço|assinar|assinatura|pagar o cash|quanto custa)\b/.test(value)) {
    return { intent: 'plans', confidence: 'high', canonical: 'planos' };
  }
  if (/\b(trial|teste gratis|teste grátis|periodo gratuito|período gratuito|dias gratis|dias grátis)\b/.test(value)) {
    return { intent: 'trial', confidence: 'high', canonical: 'trial' };
  }
  if (/\b(categorias|categoria automatica|categoria automática|como categoriza|classifica meus gastos)\b/.test(value)) {
    return { intent: 'categories', confidence: 'high', canonical: 'categorias' };
  }

  if (deterministicCashQuery(input)) return { intent: 'query', confidence: 'high', canonical: input };
  if (!isCashProtectedNonTransaction(input) && explicitMovement(value) && hasMoney(value)) {
    return { intent: 'transaction', confidence: 'high', canonical: input };
  }

  return { intent: 'unknown', confidence: 'medium' };
}

function batchSegments(input: string): string[] {
  return String(input ?? '')
    .split(/\n+|;+/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function sectionHeader(value: string): 'income' | 'expense' | null {
  const clean = normalizeCashCorpusText(value).replace(/[:\-–—]+$/g, '').trim();
  if (/^(despesas?|gastos?|saidas?|compras?)$/.test(clean)) return 'expense';
  if (/^(entradas?|receitas?|ganhos?|recebimentos?)$/.test(clean)) return 'income';
  return null;
}

function prefixedSection(value: string): { section: 'income' | 'expense' | null; text: string } {
  const match = value.match(/^\s*(despesas?|gastos?|sa[ií]das?|compras?|entradas?|receitas?|ganhos?|recebimentos?)\s*[:\-–—]\s*(.*)$/i);
  if (!match) return { section: null, text: value };
  return { section: sectionHeader(match[1] ?? ''), text: String(match[2] ?? '').trim() };
}

export function deterministicCashBatch(input: string): CashTransactionInput[] {
  if (!looksBatch(input) || isCashProtectedNonTransaction(input)) return [];
  const rows: CashTransactionInput[] = [];
  let section: 'income' | 'expense' | null = null;

  for (const raw of batchSegments(input)) {
    const header = sectionHeader(raw);
    if (header) { section = header; continue; }

    const prefixed = prefixedSection(raw);
    if (prefixed.section) section = prefixed.section;
    const line = prefixed.text;
    if (!line) continue;

    const hasMovement = explicitMovement(normalizeCashCorpusText(line));
    const candidate = section && !hasMovement
      ? `${section === 'income' ? 'recebi' : 'gastei'} ${line}`
      : line;
    const parsed = deterministicCashParse(candidate);
    if (!parsed) continue;
    rows.push(section
      ? {
          ...parsed,
          type: section,
          category: section === 'income' ? 'Receita' : parsed.category === 'Receita' ? 'Outros' : parsed.category
        }
      : parsed);
  }
  return rows.slice(0, 12);
}

function resultText(result: VerticalResult | null): string {
  if (!result) return '';
  return result.actions
    .filter(action => action.type === 'text')
    .map(action => action.type === 'text' ? action.text : '')
    .join('\n');
}

function safeDeterministicResult(result: VerticalResult | null): boolean {
  const output = resultText(result).trimStart();
  return Boolean(output)
    && !output.startsWith('Hmm, não entendi bem')
    && !output.startsWith('Não consegui interpretar isso com segurança');
}

export async function handleCashConversationCorpus(context: VerticalContext): Promise<VerticalResult | null> {
  const route = classifyCashCorpus(context.combinedText);

  if (route.intent === 'greeting') {
    return text('Oi! 👋 Pode me mandar um gasto, uma entrada, perguntar seu saldo, criar um cofrinho ou agendar uma previsão financeira.');
  }
  if (route.intent === 'acknowledgement') {
    return text('Perfeito 😊 Pode continuar falando comigo do seu jeito.');
  }

  if (route.intent === 'schedule') {
    const result = await handleCashScheduleDeterministic({ ...context, combinedText: route.canonical ?? context.combinedText });
    if (result) return result;
  }
  if (route.intent === 'projection') {
    const result = await handleCashScheduleDeterministic({ ...context, combinedText: route.canonical ?? context.combinedText });
    if (result) return result;
  }
  if (route.intent === 'pocket') {
    const result = await handleCashPocketCommand({ ...context, combinedText: route.canonical ?? context.combinedText });
    if (result) return result;
  }

  if (route.intent === 'query') {
    const result = await cashQuery.handle(context.company.id, route.canonical ?? context.combinedText);
    if (result) return result;
  }

  if (route.intent === 'batch_transaction') {
    const rows = deterministicCashBatch(context.combinedText);
    if (rows.length >= 2) return await stageCashRegistration(context, rows, context.combinedText);
  }

  if (route.intent === 'transaction') {
    const parsed = deterministicCashParse(context.combinedText);
    if (parsed) return await stageCashRegistration(context, [parsed], context.combinedText);
  }

  if (route.intent === 'help') {
    const section = cashHelpSection(context.combinedText) ?? 'menu';
    return text(cashHelpMessage(section));
  }

  if (['history', 'weekly_report', 'monthly_report', 'edit', 'delete', 'undo'].includes(route.intent)) {
    const result = await cashConversationHandler.handle({ ...context, combinedText: route.canonical ?? context.combinedText });
    if (safeDeterministicResult(result)) return result;
  }

  return null;
}
