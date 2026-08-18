import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashParser, descriptionFrom } from './parser.js';
import { stageCashRegistration } from './confirmation.js';
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
type BatchSection = 'income' | 'expense' | null;

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

export function isCashCasualAcknowledgement(input: string): boolean {
  const value = normalize(input).replace(/[!.]+$/g, '').trim();
  return /^(certo|ok|okay|blz|beleza|entendi|entendido|show|perfeito|ta bom|tá bom|tranquilo|valeu|obrigado|obrigada|massa|top)$/.test(value);
}

function isTrialDefinitionRequest(input: string): boolean {
  const value = normalize(input);
  return /\b(o que e|oq e|que e|significa|como funciona)\b.*\b(trial|teste gratis|periodo gratuito)\b/.test(value)
    || /^trial\??$/.test(value);
}

export function isCashExpenseListRequest(input: string): boolean {
  const value = normalize(input);
  if (/\b(lista|listar|organiza|organizar|organizada|organizado|mostra|mostrar|ver)\b.*\b(gast|despes|compr|pague)\w*/.test(value)) return true;
  if (/\b(meus gastos|minhas despesas)\b.*\b(foi|foram|citei|falei|disse|acima|antes)\b/.test(value)) return true;
  if (/\b(ja citei|falei acima|disse acima)\b.*\b(gast|despes)\w*/.test(value)) return true;
  return false;
}

function looksLikeFinancialQuery(input: string): boolean {
  const value = normalize(input);
  if (/\?$/.test(input.trim()) && /\b(quanto|quais|qual|como|onde|mostra|lista|saldo|historico|histórico|gastos?|despesas?|receitas?)\b/.test(value)) return true;
  if (/\b(quanto|quais|qual|me mostra|mostra|lista|listar|pesquisa|procura)\b.*\b(gast|despes|receit|registro|lancamento|lançamento|saldo|movimenta)\w*/.test(value)) return true;
  if (/^(saldo|historico|histórico|relatorio|relatório|resumo|balanco|balanço)\b/.test(value)) return true;
  return false;
}

function asksToUseQuotedMessage(input: string): boolean {
  const value = normalize(input);
  return /\b(registra|registre|lanca|lança|anota|salva|salve)\b.*\b(isso|essa mensagem|o que mandei|o que falei)\b/.test(value);
}

function hasSeveralMoneyValues(input: string): boolean {
  const matches = String(input ?? '').match(/(?:r\$\s*)?\d+(?:\.\d{3})*(?:[.,]\d{1,2})?/gi) ?? [];
  return matches.length >= 2;
}

function hasMovementLanguage(input: string): boolean {
  return /\b(ganhei|recebi|entrou|salario|salário|gastei|paguei|comprei|custou|guardei|reservei|separei|pague|despesas?|gastos?|sa[ií]das?|entradas?|receitas?|ganhos?)\b/i.test(input);
}

export function cashBatchSectionHeader(input: string): BatchSection {
  const value = normalize(input).replace(/[:\-–—]+$/g, '').trim();
  if (/^(despesas?|gastos?|saidas?|compras?)$/.test(value)) return 'expense';
  if (/^(entradas?|receitas?|ganhos?|recebimentos?)$/.test(value)) return 'income';
  return null;
}

function hasBatchListHeader(input: string): boolean {
  return /(?:^|\n)\s*(despesas?|gastos?|sa[ií]das?|compras?|entradas?|receitas?|ganhos?|recebimentos?)\s*[:\-–—]?\s*(?:$|\n)/im.test(input)
    || /\b(despesas?|gastos?|sa[ií]das?|entradas?|receitas?)\s*:\s*[^\n]+/i.test(input);
}

export function looksLikeCashBatch(input: string): boolean {
  if (!hasSeveralMoneyValues(input) || !hasMovementLanguage(input)) return false;
  const verbs = input.match(/\b(ganhei|recebi|entrou|gastei|paguei|comprei|guardei|reservei|separei)\b/gi) ?? [];
  return verbs.length >= 2 || input.includes('\n') || input.includes(';') || hasBatchListHeader(input);
}

function missingAmountExpense(input: string): boolean {
  const value = normalize(input);
  return /\b(paguei|gastei|comprei|custou)\b/.test(value) && !/\d/.test(value);
}

function normalizeDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : isoBrazil();
}

function simpleSegments(input: string): string[] {
  return input
    .split(/\n+|;+/)
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function sectionPrefix(segment: string): { section: BatchSection; remainder: string } {
  const match = segment.match(/^\s*(despesas?|gastos?|sa[ií]das?|compras?|entradas?|receitas?|ganhos?|recebimentos?)\s*[:\-–—]\s*(.*)$/i);
  if (!match) return { section: null, remainder: segment };
  const section = cashBatchSectionHeader(match[1] ?? '');
  return { section, remainder: String(match[2] ?? '').trim() };
}

export function adjustCashRemainder(segment: string, transaction: CashTransactionInput): CashTransactionInput {
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
  let section: BatchSection = null;

  for (const rawSegment of simpleSegments(input)) {
    const directHeader = cashBatchSectionHeader(rawSegment);
    if (directHeader) {
      section = directHeader;
      continue;
    }

    const prefixed = sectionPrefix(rawSegment);
    if (prefixed.section) section = prefixed.section;
    const segment = prefixed.remainder;
    if (!segment) continue;

    if (/\b(sobrou|restou)\b/i.test(segment) && !/\b(comprei|gastei|paguei)\b/i.test(segment)) continue;

    const candidate = section && !/\b(ganhei|recebi|entrou|gastei|paguei|comprei|guardei|reservei|separei)\b/i.test(segment)
      ? `${section === 'income' ? 'recebi' : 'gastei'} ${segment}`
      : segment;

    const parsed = await cashParser.parse(candidate);
    if (!parsed) continue;

    const typed = section
      ? {
          ...parsed,
          type: section,
          category: section === 'income' ? 'Receita' : parsed.category === 'Receita' ? 'Outros' : parsed.category
        } satisfies CashTransactionInput
      : parsed;

    rows.push(adjustCashRemainder(segment, typed));
    if (rows.length >= 12) break;
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
            'A mensagem pode misturar receita, dinheiro reservado, despesas reais, contas futuras, recorrências, estimativas e hipóteses.',
            'Crie um item por movimento REAL já ocorrido. Nunca junte movimentos diferentes em uma descrição.',
            'Inclua SOMENTE dinheiro que já entrou, já saiu ou que o usuário afirma ter realmente separado/reservado.',
            'Pagamento agendado, conta que ainda vence, recorrência futura, estimativa, média, projeção ou cenário condicionado por “se/caso” NÃO é lançamento real: include=false.',
            'Exemplos que devem ficar include=false: “estimo receber 1200”, “se eu viajar gastarei 900”, “todo dia 10 pago 320”, “mês que vem o condomínio será 420”, “fecharei o semestre com 4500 de sobra”.',
            '“Já reservei R$150 para o presente” é movimento real de Reserva; “pretendo reservar R$150” não é.',
            'Listas com cabeçalhos devem herdar o tipo. Ex.: “Despesas:\nMercado 50\nUber 20” = duas despesas; “Entradas:\nFreela 300\nVenda 200” = duas receitas.',
            'Se houver novos cabeçalhos no meio da mensagem, troque o tipo das linhas seguintes de acordo com o novo cabeçalho.',
            'income = dinheiro que entrou. expense = dinheiro que saiu do dinheiro disponível.',
            '“guardei”, “reservei” ou “separei dinheiro” é expense com categoria Reserva somente quando a frase afirma que isso já aconteceu.',
            '“sobrou 20” sozinho NÃO é lançamento.',
            'Se havia um valor para gastar e a pessoa informa quanto sobrou, registre somente o gasto efetivo. Ex.: “com os outros 100 comprei coisas e sobrou 20” => despesa de 80.',
            'Não invente valores. Se um gasto foi citado sem valor identificável, include=false.',
            'Use somente: Alimentação, Transporte, Saúde, Moradia, Educação, Pessoal, Reserva, Receita, Outros.',
            'Toda receita usa Receita. Dinheiro guardado usa Reserva.',
            'description deve ser curta, específica e preservar os itens citados pelo usuário.',
            'Se o usuário listar pão, leite, café e frutas, escreva esses itens; NUNCA substitua por “itens diversos”, “compras diversas”, “coisas diversas” ou outro resumo genérico.',
            'merchant só quando houver loja/pessoa/local claro.',
            `Hoje no fuso do Brasil é ${isoBrazil()}. transaction_date deve ser YYYY-MM-DD.`,
            'source_text deve conter SOMENTE o trecho curto da mensagem que sustenta aquele item; não copie a narrativa inteira para a descrição.'
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

function hasItemEnumeration(value: string): boolean {
  const clean = String(value ?? '').trim();
  return /[,;]/.test(clean) || /\b\w+\s+e\s+\w+\b/i.test(clean);
}

function specificDescription(item: BatchItem): string {
  const aiDescription = item.description.trim();
  const sourceDescription = descriptionFrom(item.source_text).trim();
  const generic = /\b(itens? diversos?|compras? diversas?|coisas? diversas?|varios itens|vários itens)\b/i.test(aiDescription);

  if (sourceDescription && (generic || hasItemEnumeration(item.source_text))) {
    return sourceDescription.slice(0, 500);
  }
  return (aiDescription || sourceDescription || item.source_text.trim()).slice(0, 500);
}

function canonicalBatchItem(item: BatchItem): CashTransactionInput | null {
  if (!item.amount || item.amount <= 0) return null;
  return {
    type: item.type,
    amount: Math.round(item.amount * 100) / 100,
    category: item.type === 'income' ? 'Receita' : item.category,
    merchant: item.merchant.trim().slice(0, 120),
    description: specificDescription(item),
    transactionDate: normalizeDate(item.transaction_date)
  };
}

async function prepareBatch(context: VerticalContext, source: string): Promise<VerticalResult | null> {
  const aiItems = await aiBatch(source);
  let transactions = (aiItems ?? [])
    .map(canonicalBatchItem)
    .filter((item): item is CashTransactionInput => Boolean(item));
  if (transactions.length < 2) transactions = await fallbackBatch(source);
  if (transactions.length < 2) return null;
  return await stageCashRegistration(context, transactions, source);
}

async function trialDefinition(companyId: string): Promise<VerticalResult> {
  const { cashService } = await import('./service.js');
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

  if (isCashCasualAcknowledgement(input)) {
    return { kind: 'result', result: text('Perfeito 😊 Quando quiser, pode me mandar um gasto, uma receita ou perguntar sobre suas finanças do seu jeito.') };
  }

  if (/^(sim|isso|sim entao|sim então)\s+(?:formule|reformule|pode formular|pode reformular)[!. ]*$/i.test(input.trim())) {
    return { kind: 'result', result: text('Pode mandar do jeito que você lembrar 😊 Se estiver falando de uma mensagem anterior, responda aquela mensagem e diga o que quer ver ou registrar.') };
  }

  const quotedText = String(context.message.quotedText ?? '').trim();
  const source = quotedText && asksToUseQuotedMessage(input) ? quotedText : input;

  if (looksLikeCashBatch(source)) {
    const result = await prepareBatch(context, source);
    if (result) return { kind: 'result', result };
  }

  if (isCashExpenseListRequest(input)) {
    return { kind: 'rewrite', text: 'quais foram meus gastos hoje?' };
  }

  if (missingAmountExpense(input)) {
    return { kind: 'result', result: text('Consigo registrar isso, mas preciso do valor 😊\nExemplo: “paguei R$100 nas unhas e R$100 na bicicleta”.') };
  }

  if (!looksLikeFinancialQuery(input)) {
    const parsed = await cashParser.parse(source);
    if (parsed) {
      return { kind: 'result', result: await stageCashRegistration(context, [parsed], source) };
    }
  }

  return null;
}