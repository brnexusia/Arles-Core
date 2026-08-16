import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashParser } from './parser.js';
import { cashService } from './service.js';
import type { CashTransactionInput } from './types.js';
import { formatBrazilDate, isoBrazil } from './time.js';

const CATEGORIES = [
  'Alimentação',
  'Transporte',
  'Saúde',
  'Moradia',
  'Educação',
  'Pessoal',
  'Reserva',
  'Receita',
  'Outros'
] as const;

const BatchItemSchema = z.object({
  include: z.boolean(),
  type: z.enum(['income', 'expense']),
  amount: z.number().positive().nullable(),
  category: z.enum(CATEGORIES),
  merchant: z.string(),
  description: z.string(),
  transaction_date: z.string(),
  source_text: z.string()
});

const BatchSchema = z.object({
  is_batch: z.boolean(),
  items: z.array(BatchItemSchema).max(12),
  clarification: z.string().nullable()
});

type BatchItem = z.infer<typeof BatchItemSchema>;

export type CashSmartInput =
  | { kind: 'result'; result: VerticalResult }
  | { kind: 'rewrite'; text: string }
  | null;

const client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function brl(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function isCasualAcknowledgement(input: string): boolean {
  const value = normalize(input).replace(/[!.]+$/g, '').trim();
  return /^(certo|ok|okay|blz|beleza|entendi|entendido|show|perfeito|ta bom|tá bom|tranquilo|valeu|obrigado|obrigada|massa|top)$/.test(value);
}

function isTrialDefinitionRequest(input: string): boolean {
  const value = normalize(input);
  return /\b(o que e|oq e|que e|significa|como funciona)\b.*\b(trial|teste gratis|periodo gratuito)\b/.test(value)
    || /^trial\??$/.test(value);
}

function isExpenseListRequest(input: string): boolean {
  const value = normalize(input);
  if (/\b(lista|listar|organiza|organizar|organizada|organizado|mostra|mostrar|ver)\b.*\b(gast|despes|compr|pague)\w*/.test(value)) return true;
  if (/\b(meus gastos|minhas despesas)\b.*\b(foi|foram|citei|falei|disse|acima|antes)\b/.test(value)) return true;
  if (/\b(ja citei|já citei|falei acima|disse acima)\b.*\b(gast|despes)\w*/.test(value)) return true;
  return false;
}

function asksToUseQuotedMessage(input: string): boolean {
  const value = normalize(input);
  return /\b(registra|registre|lanca|lança|anota|salva|salve)\b.*\b(isso|essa mensagem|o que mandei|o que falei)\b/.test(value)
    || /\b(esses|estes|isso)\b.*\b(foram|sao|são)\b.*\b(meus gastos|minhas despesas|meus lancamentos|meus lançamentos)\b/.test(value);
}

function hasSeveralMoneyValues(input: string): boolean {
  const matches = String(input ?? '').match(/(?:r\$\s*)?\d+(?:\.\d{3})*(?:[.,]\d{1,2})?/gi) ?? [];
  return matches.length >= 2;
}

function hasMovementLanguage(input: string): boolean {
  return /\b(ganhei|recebi|entrou|salario|salário|gastei|paguei|comprei|custou|guardei|reservei|separei|pague|comprei)\b/i.test(input);
}

function looksLikeBatch(input: string): boolean {
  if (!hasSeveralMoneyValues(input) || !hasMovementLanguage(input)) return false;
  const verbs = input.match(/\b(ganhei|recebi|entrou|gastei|paguei|comprei|guardei|reservei|separei)\b/gi) ?? [];
  return verbs.length >= 2 || input.includes('\n');
}

function missingAmountExpense(input: string): boolean {
  const value = normalize(input);
  const hasExpenseVerb = /\b(paguei|gastei|comprei|custou)\b/.test(value);
  const hasMoney = /\d/.test(value);
  return hasExpenseVerb && !hasMoney;
}

function normalizeDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : isoBrazil();
}

function simpleSegments(input: string): string[] {
  return input
    .split(/\n+|;+/)
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function adjustRemainder(segment: string, transaction: CashTransactionInput): CashTransactionInput {
  const value = normalize(segment);
  const budget = value.match(/\b(?:outros?|restante|resto)\s+(\d+(?:[.,]\d{1,2})?)/);
  const leftover = value.match(/\b(?:sobrou|sobraram|restou|restaram)\s+(\d+(?:[.,]\d{1,2})?)/);
  if (!budget || !leftover) return transaction;
  const total = Number(budget[1]!.replace(',', '.'));
  const rest = Number(leftover[1]!.replace(',', '.'));
  if (!Number.isFinite(total) || !Number.isFinite(rest) || total <= rest || rest < 0) return transaction;
  return { ...transaction, amount: Math.round((total - rest) * 100) / 100 };
}

async function fallbackBatch(input: string): Promise<CashTransactionInput[]> {
  const rows: CashTransactionInput[] = [];
  for (const segment of simpleSegments(input)) {
    if (/\b(sobrou|restou)\b/i.test(segment) && !/\b(comprei|gastei|paguei)\b/i.test(segment)) continue;
    const parsed = await cashParser.parse(segment);
    if (!parsed) continue;
    rows.push(adjustRemainder(segment, parsed));
  }
  return rows;
}

async function aiBatch(input: string): Promise<BatchItem[] | null> {
  if (!client) return null;
  try {
    const response = await client.responses.parse({
      model: env.openaiModel,
      input: [
        {
          role: 'system',
          content: [
            'Você separa uma mensagem do Arles Cash em lançamentos financeiros distintos.',
            'A mensagem pode misturar receita, dinheiro reservado e várias despesas.',
            'Crie um item por movimento REAL. Nunca junte movimentos diferentes em uma descrição.',
            'income = dinheiro que entrou. expense = dinheiro que saiu do dinheiro disponível.',
            '“guardei”, “reservei” ou “separei dinheiro” é expense com categoria Reserva, pois reduz o dinheiro disponível, mas deve ficar claramente identificado como reserva.',
            '“sobrou 20” sozinho NÃO é lançamento.',
            'Quando a pessoa disser explicitamente que tinha um valor para gastar e informa quanto sobrou, você pode registrar somente o que foi efetivamente gasto. Ex.: “com os outros 100 comprei coisas e sobrou 20” => despesa de 80.',
            'Não invente valores. Se um gasto foi citado sem valor identificável, include=false.',
            'Use somente: Alimentação, Transporte, Saúde, Moradia, Educação, Pessoal, Reserva, Receita, Outros.',
            'Toda receita usa categoria Receita. Dinheiro guardado usa Reserva.',
            'description deve ser curta e específica. merchant só quando houver loja/pessoa/local claro.',
            `Hoje no fuso do Brasil é ${isoBrazil()}. transaction_date deve ser YYYY-MM-DD.`,
            'source_text deve conter o trecho da mensagem que sustenta aquele item.'
          ].join('\n')
        },
        { role: 'user', content: input }
      ],
      text: { format: zodTextFormat(BatchSchema, 'cash_batch') }
    });
    const parsed = response.output_parsed;
    if (!parsed?.is_batch) return null;
    return parsed.items.filter(item => item.include && item.amount && item.amount > 0);
  } catch (error) {
    console.error('[CashSmartInput] falha interpretando lote:', error);
    return null;
  }
}

function canonicalBatchItem(item: BatchItem): CashTransactionInput | null {
  if (!item.amount || item.amount <= 0) return null;
  return {
    type: item.type,
    amount: Math.round(item.amount * 100) / 100,
    category: item.type === 'income' ? 'Receita' : item.category,
    merchant: item.merchant.trim().slice(0, 120),
    description: item.description.trim().slice(0, 500) || item.source_text.trim().slice(0, 500),
    transactionDate: normalizeDate(item.transaction_date)
  };
}

async function saveBatch(context: VerticalContext, source: string): Promise<VerticalResult | null> {
  const aiItems = await aiBatch(source);
  let transactions = (aiItems ?? [])
    .map(canonicalBatchItem)
    .filter((item): item is CashTransactionInput => Boolean(item));

  if (transactions.length < 2) transactions = await fallbackBatch(source);
  if (transactions.length < 2) return null;

  const saved: CashTransactionInput[] = [];
  for (let index = 0; index < transactions.length; index += 1) {
    const transaction = transactions[index]!;
    await cashService.createTransaction({
      companyId: context.company.id,
      phone: context.message.phone,
      sourceMessageId: `${context.message.messageId || Date.now()}:item:${index + 1}`,
      sourceMessage: source,
      transaction
    });
    saved.push(transaction);
  }

  const income = saved.filter(item => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
  const expense = saved.filter(item => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
  const lines = saved.map((item, index) => {
    const icon = item.type === 'income' ? '💰' : item.category === 'Reserva' ? '🏦' : '💸';
    const sign = item.type === 'income' ? '+' : '-';
    return `${index + 1}. ${icon} ${sign}${brl(item.amount)} — ${item.category} — ${item.description}`;
  });

  return text([
    `✅ Entendi e separei sua mensagem em ${saved.length} lançamentos:`,
    '',
    ...lines,
    '',
    `💰 Entradas: ${brl(income)}`,
    `💸 Saídas + reservas: ${brl(expense)}`,
    `📊 Saldo desses lançamentos: ${brl(income - expense)}`,
    '',
    'Se algum item ficou diferente do que você quis dizer, pode falar naturalmente: “edita o 2”.'
  ].join('\n'));
}

async function trialDefinition(companyId: string): Promise<VerticalResult> {
  const state = await cashService.accessState(companyId);
  const status = state.subscription_status === 'trial' && state.trial_ends_at
    ? `O seu está ativo até ${formatBrazilDate(state.trial_ends_at)}.`
    : state.subscription_status === 'active'
      ? 'No seu caso, você já está com um plano pago ativo.'
      : 'No momento, seu período gratuito não está ativo.';
  return text([
    '🎁 Trial é o período de teste grátis do Arles Cash.',
    'Durante 7 dias você usa as funções normalmente, sem precisar pagar antes.',
    'Quando os 7 dias terminam, seus dados continuam salvos e você escolhe um plano para continuar usando.',
    '',
    status
  ].join('\n'));
}

export async function preprocessCashInput(context: VerticalContext): Promise<CashSmartInput> {
  const input = context.combinedText;

  if (isTrialDefinitionRequest(input)) {
    return { kind: 'result', result: await trialDefinition(context.company.id) };
  }

  if (isCasualAcknowledgement(input)) {
    return {
      kind: 'result',
      result: text('Perfeito 😊 Quando quiser, pode me mandar um gasto, uma receita ou perguntar sobre suas finanças do seu jeito.')
    };
  }

  if (/^(sim|isso|sim entao|sim então)\s+(?:formule|reformule|pode formular|pode reformular)[!. ]*$/i.test(input.trim())) {
    return {
      kind: 'result',
      result: text('Pode mandar do jeito que você lembrar 😊 Se estiver falando de uma mensagem anterior, responda aquela mensagem e diga o que quer ver ou registrar.')
    };
  }

  if (isExpenseListRequest(input)) {
    return { kind: 'rewrite', text: 'quais foram meus gastos este mês?' };
  }

  const quotedText = String(context.message.quotedText ?? '').trim();
  const source = quotedText && asksToUseQuotedMessage(input) ? quotedText : input;
  if (looksLikeBatch(source)) {
    const result = await saveBatch(context, source);
    if (result) return { kind: 'result', result };
  }

  if (missingAmountExpense(input)) {
    return {
      kind: 'result',
      result: text('Consigo registrar isso, mas preciso do valor 😊\nExemplo: “paguei R$100 nas unhas e R$100 na bicicleta”.')
    };
  }

  return null;
}
