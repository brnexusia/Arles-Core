import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { cashParser, descriptionFrom, deterministicCashParse } from './parser.js';
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

const MAX_BATCH_ITEMS = 25;
const MONEY_RE = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi;
const INCOME_CUE = /\b(ganhei|recebi|entrou|entraram|caiu|depositaram|faturei|vendi|lucrei)\b/i;
const EXPENSE_CUE = /\b(gastei|gaste|gastamos|paguei|pagamos|comprei|compramos|custou|saiu|debitaram|guardei|reservei|separei)\b/i;
const MOVEMENT_CUE = /\b(ganhei|recebi|entrou|entraram|caiu|depositaram|faturei|vendi|lucrei|gastei|gaste|gastamos|paguei|pagamos|comprei|compramos|custou|saiu|debitaram|guardei|reservei|separei)\b/i;

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
  items: z.array(BatchItemSchema).max(MAX_BATCH_ITEMS),
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

function overlaps(index: number, length: number, ranges: Array<[number, number]>): boolean {
  const end = index + length;
  return ranges.some(([start, finish]) => index < finish && end > start);
}

function rangesFor(input: string, pattern: RegExp): Array<[number, number]> {
  return [...input.matchAll(pattern)].map(match => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
}

/**
 * Retorna apenas números que realmente parecem valores monetários. Isso evita que
 * 31/07/2026, 15:30, 5%, "18 meses" ou "dia 10" façam uma mensagem parecer um lote.
 */
export function cashFinancialAmountTokens(input: string): string[] {
  const source = String(input ?? '');
  const dateRanges = rangesFor(source, /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g);
  const timeRanges = rangesFor(source, /\b\d{1,2}:\d{2}(?::\d{2})?\b/g);
  const tokens: string[] = [];

  for (const match of source.matchAll(MONEY_RE)) {
    const index = match.index ?? 0;
    if (overlaps(index, match[0].length, dateRanges) || overlaps(index, match[0].length, timeRanges)) continue;

    const before = source.slice(Math.max(0, index - 14), index);
    const after = source.slice(index + match[0].length, index + match[0].length + 18);
    const explicitCurrency = /r\$/i.test(match[0]);
    const raw = String(match[1] ?? '');
    const integer = /^\d+$/.test(raw) ? Number(raw) : null;

    if (/^\s*%/.test(after)) continue;
    if (!explicitCurrency && /\bdia\s*$/i.test(before)) continue;
    if (!explicitCurrency && /^\s*(?:dias?|meses?|anos?|semanas?|horas?|minutos?|parcelas?|vezes)\b/i.test(after)) continue;
    if (!explicitCurrency && integer != null && integer >= 1900 && integer <= 2200) continue;

    tokens.push(match[0]);
  }
  return tokens;
}

function hasSeveralMoneyValues(input: string): boolean {
  return cashFinancialAmountTokens(input).length >= 2;
}

function hasMovementLanguage(input: string): boolean {
  return MOVEMENT_CUE.test(input)
    || /\b(salario|salário|despesas?|gastos?|sa[ií]das?|entradas?|receitas?|ganhos?|recebimentos?)\b/i.test(input);
}

export function cashBatchSectionHeader(input: string): BatchSection {
  const value = normalize(input).replace(/[:\-–—]+$/g, '').trim();
  if (/^(despesas?|gastos?|saidas?|compras?|pagamentos?)$/.test(value)) return 'expense';
  if (/^(entradas?|receitas?|ganhos?|recebimentos?|vendas?)$/.test(value)) return 'income';
  return null;
}

/**
 * Detecta mudança de seção mesmo em linguagem natural. Um verbo ou cabeçalho vale
 * para as linhas seguintes até aparecer um novo contexto financeiro explícito.
 */
export function cashBatchSectionCue(input: string): BatchSection {
  const value = normalize(input);
  if (INCOME_CUE.test(value)) return 'income';
  if (EXPENSE_CUE.test(value)) return 'expense';
  if (/^(?:meus?|minhas?|as|os)?\s*(?:entradas?|receitas?|ganhos?|recebimentos?|vendas?)\b/.test(value)) return 'income';
  if (/^(?:meus?|minhas?|as|os)?\s*(?:despesas?|gastos?|saidas?|compras?|pagamentos?)\b/.test(value)) return 'expense';

  if (!cashFinancialAmountTokens(input).length) {
    if (/\b(entradas?|receitas?|ganhos?|recebimentos?|vendas?)\b/.test(value)) return 'income';
    if (/\b(despesas?|gastos?|saidas?|compras?|pagamentos?)\b/.test(value)) return 'expense';
  }
  return cashBatchSectionHeader(input);
}

function hasBatchListHeader(input: string): boolean {
  return /(?:^|\n)\s*(despesas?|gastos?|sa[ií]das?|compras?|pagamentos?|entradas?|receitas?|ganhos?|recebimentos?|vendas?)\s*[:\-–—]?\s*(?:$|\n)/im.test(input)
    || /\b(despesas?|gastos?|sa[ií]das?|entradas?|receitas?|ganhos?)\s*:\s*[^\n]+/i.test(input);
}

export function looksLikeCashBatch(input: string): boolean {
  if (!hasSeveralMoneyValues(input) || !hasMovementLanguage(input)) return false;
  const verbs = input.match(/\b(ganhei|recebi|entrou|entraram|caiu|depositaram|faturei|vendi|lucrei|gastei|gaste|gastamos|paguei|pagamos|comprei|compramos|guardei|reservei|separei)\b/gi) ?? [];
  return verbs.length >= 2 || input.includes('\n') || input.includes(';') || hasBatchListHeader(input);
}

function missingAmountExpense(input: string): boolean {
  const value = normalize(input);
  return /\b(paguei|gastei|gaste|comprei|custou)\b/.test(value) && cashFinancialAmountTokens(input).length === 0;
}

function normalizeDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : isoBrazil();
}

function stripListMarker(value: string): string {
  return value
    .replace(/^\s*(?:[-–—•▪◦*]|\d{1,2}[.)])\s+/, '')
    .trim();
}

function splitInlineClauses(value: string): string[] {
  const first = value
    .split(/\s*;\s*/)
    .flatMap(part => part.split(/,\s+(?=(?:r\$\s*)?\d)/i))
    .flatMap(part => part.split(/\s+e\s+(?=(?:r\$\s*)?\d)/i))
    .flatMap(part => part.split(/\s+(?=(?:e\s+)?(?:tamb[eé]m\s+)?(?:eu\s+)?(?:ganhei|recebi|entrou|faturei|vendi|gastei|gaste|paguei|comprei)\b)/i));
  return first.map(stripListMarker).filter(Boolean);
}

function simpleSegments(input: string): string[] {
  return input
    .split(/\n+/)
    .flatMap(splitInlineClauses)
    .map(stripListMarker)
    .filter(Boolean)
    .slice(0, 60);
}

function sectionPrefix(segment: string): { section: BatchSection; remainder: string } {
  const match = segment.match(/^\s*(despesas?|gastos?|sa[ií]das?|compras?|pagamentos?|entradas?|receitas?|ganhos?|recebimentos?|vendas?)\s*[:\-–—]\s*(.*)$/i);
  if (!match) return { section: null, remainder: segment };
  const section = cashBatchSectionHeader(match[1] ?? '');
  return { section, remainder: String(match[2] ?? '').trim() };
}

function temporalCue(input: string): string | null {
  const match = String(input).match(/\b(hoje|ontem|anteontem|domingo|segunda(?:-feira)?|terça(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sábado|sabado|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\b/i);
  return match?.[1] ?? null;
}

function normalizeMovementTypos(input: string): string {
  return String(input)
    .replace(/^\s*(?:e\s+)?(?:tamb[eé]m\s+)?/i, '')
    .replace(/\bgaste\b/gi, 'gastei')
    .replace(/\bpague\b/gi, 'paguei')
    .replace(/\b(ganhei|recebi|entrou|faturei|vendi|gastei|paguei|comprei)\s*:\s*/gi, '$1 ')
    .trim();
}

/**
 * Contexto herdado só serve para fatos. Linhas futuras, condicionais, estimadas ou
 * contas a receber continuam fora do saldo real mesmo que estejam abaixo de "Entradas"
 * ou "Gastos".
 */
export function isCashNonRealBatchSegment(input: string): boolean {
  const value = normalize(input);
  if (!value) return false;

  if (/\b(falta cobrar|a receber|por receber|ficou devendo|esta devendo|está devendo|tenho que cobrar|preciso cobrar)\b/.test(value)) return true;
  if (/\b(estimo|estimativa|prevejo|previsao|previsão|projecao|projeção|imagino|talvez|hipoteticamente|se eu|caso eu|se conseguir|se decidir|se optar)\b/.test(value)) return true;
  if (/\b(?:vou|irei|pretendo|planejo)\s+(?:gastar|pagar|comprar|receber|ganhar|faturar|vender|separar|guardar)\b/.test(value)) return true;

  const factual = MOVEMENT_CUE.test(value);
  if (!factual && /\b(agendad[oa]|programad[oa]|vence|vencera|vencerá|todo dia|todos os dias|toda semana|todo mes|todo mês|mensalmente|semanalmente|anualmente|recorrente)\b/.test(value)) return true;
  if (!factual && /\b(amanha|depois de amanha|semana que vem|mes que vem|mês que vem|ano que vem|proxima semana|próxima semana|proximo mes|próximo mês|daqui a\s+\d+)\b/.test(value) && cashFinancialAmountTokens(input).length > 0) return true;

  return false;
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

export async function fallbackBatch(input: string): Promise<CashTransactionInput[]> {
  const rows: CashTransactionInput[] = [];
  let section: BatchSection = null;
  let inheritedDate: string | null = null;

  for (const rawSegment of simpleSegments(input)) {
    const directHeader = cashBatchSectionHeader(rawSegment);
    const rawDate = temporalCue(rawSegment);
    if (rawDate) inheritedDate = rawDate;

    if (directHeader) {
      section = directHeader;
      continue;
    }

    const prefixed = sectionPrefix(rawSegment);
    if (prefixed.section) section = prefixed.section;
    const segment = prefixed.remainder;
    if (!segment) continue;

    const explicitSection = cashBatchSectionCue(segment);
    const hasMoney = cashFinancialAmountTokens(segment).length > 0;
    if (explicitSection) section = explicitSection;

    // "ontem eu ganhei", "minhas despesas foram" etc. podem ser cabeçalhos narrativos.
    if (explicitSection && !hasMoney) continue;
    if (isCashNonRealBatchSegment(segment)) continue;

    if (/\b(sobrou|restou)\b/i.test(segment) && !/\b(comprei|gastei|gaste|paguei)\b/i.test(segment)) continue;

    const normalizedSegment = normalizeMovementTypos(segment);
    const hasExplicitMovement = MOVEMENT_CUE.test(normalizedSegment);
    const hasOwnDate = Boolean(temporalCue(normalizedSegment));
    const inheritedDateText = inheritedDate && !hasOwnDate ? ` ${inheritedDate}` : '';

    const candidate = section && !hasExplicitMovement
      ? `${section === 'income' ? 'recebi' : 'gastei'}${inheritedDateText} ${normalizedSegment}`
      : `${normalizedSegment}${inheritedDateText}`;

    const parsed = deterministicCashParse(candidate);
    if (!parsed) continue;

    const typed = section
      ? {
          ...parsed,
          type: section,
          category: section === 'income' ? 'Receita' : parsed.category === 'Receita' ? 'Outros' : parsed.category
        } satisfies CashTransactionInput
      : parsed;

    rows.push(adjustCashRemainder(segment, typed));
    if (rows.length >= MAX_BATCH_ITEMS) break;
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
            'A mensagem pode misturar receitas, reservas, despesas reais, contas futuras, recorrências, estimativas e hipóteses.',
            `Extraia no máximo ${MAX_BATCH_ITEMS} movimentos reais. Crie um item por movimento; nunca junte movimentos distintos numa descrição.`,
            'Inclua SOMENTE dinheiro que já entrou, já saiu ou que o usuário afirma ter realmente separado/reservado.',
            'Pagamento agendado, conta que ainda vence, recorrência futura, estimativa, média, projeção ou cenário condicionado por “se/caso” NÃO é lançamento real: include=false.',
            'Valores a receber, “falta cobrar”, dívidas de terceiros e dinheiro apenas esperado também NÃO são receita real até o recebimento acontecer.',
            'Datas, horários, percentuais, quantidade de parcelas, meses, dias e anos NÃO são valores financeiros.',
            'Exemplos que devem ficar include=false: “estimo receber 1200”, “se eu viajar gastarei 900”, “todo dia 10 pago 320”, “mês que vem o condomínio será 420”, “fecharei o semestre com 4500 de sobra”.',
            '“Já reservei R$150 para o presente” é movimento real de Reserva; “pretendo reservar R$150” não é.',
            'Listas com cabeçalhos devem herdar o tipo. Ex.: “Despesas:\nMercado 50\nUber 20” = duas despesas; “Entradas:\nFreela 300\nVenda 200” = duas receitas.',
            'Cabeçalhos narrativos também devem ser herdados. Ex.: “eu ganhei hoje\n46 de ajuste\n28 de reforma” = duas receitas; “ganhei” vale para as linhas seguintes até surgir novo contexto.',
            'O mesmo vale para sinônimos e pequenas variações: entradas/receitas/ganhos/recebimentos e despesas/gastos/saídas/compras/pagamentos.',
            'Se houver novo cabeçalho ou verbo de movimento no meio da mensagem, troque o tipo das linhas seguintes.',
            'Se uma linha contiver vários movimentos separados por “e”, vírgula, ponto ou ponto e vírgula, crie itens separados quando cada valor tiver descrição própria.',
            'income = dinheiro que entrou. expense = dinheiro que saiu do dinheiro disponível.',
            '“guardei”, “reservei” ou “separei dinheiro” é expense com categoria Reserva somente quando a frase afirma que isso já aconteceu.',
            '“sobrou 20” sozinho NÃO é lançamento.',
            'Se havia um valor para gastar e a pessoa informa quanto sobrou, registre somente o gasto efetivo. Ex.: “com os outros 100 comprei coisas e sobrou 20” => despesa de 80.',
            'Não invente valores. Se um movimento foi citado sem valor identificável, include=false.',
            'Use somente: Alimentação, Transporte, Saúde, Moradia, Educação, Pessoal, Reserva, Receita, Outros.',
            'Toda receita usa Receita. Dinheiro guardado usa Reserva.',
            'description deve ser curta, específica e preservar o item citado pelo usuário.',
            'Se o usuário listar pão, leite, café e frutas, preserve esses itens; nunca substitua por resumo genérico.',
            'merchant só quando houver loja/pessoa/local claro.',
            `Hoje no fuso do Brasil é ${isoBrazil()}. transaction_date deve ser YYYY-MM-DD.`,
            'source_text deve conter SOMENTE o trecho curto da mensagem que sustenta aquele item; não copie a narrativa inteira.'
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

function coverageKey(item: CashTransactionInput): string {
  return `${item.type}|${Math.round(item.amount * 100)}|${item.transactionDate}`;
}

function containsTransactionMultiset(container: CashTransactionInput[], subset: CashTransactionInput[]): boolean {
  const counts = new Map<string, number>();
  for (const item of container) counts.set(coverageKey(item), (counts.get(coverageKey(item)) ?? 0) + 1);
  for (const item of subset) {
    const key = coverageKey(item);
    const left = counts.get(key) ?? 0;
    if (left <= 0) return false;
    counts.set(key, left - 1);
  }
  return true;
}

/**
 * A IA pode ser semanticamente melhor, mas nunca deve vencer só por ter retornado
 * "alguns" itens. Preferimos a lista que cobre integralmente a outra; em conflito,
 * a lista maior vence e, em empate, o parser determinístico é a opção conservadora.
 */
export function selectCashBatchTransactions(
  aiTransactions: CashTransactionInput[],
  deterministic: CashTransactionInput[]
): CashTransactionInput[] {
  if (!aiTransactions.length) return deterministic;
  if (!deterministic.length) return aiTransactions;

  if (deterministic.length >= aiTransactions.length && containsTransactionMultiset(deterministic, aiTransactions)) {
    return deterministic;
  }
  if (aiTransactions.length >= deterministic.length && containsTransactionMultiset(aiTransactions, deterministic)) {
    return aiTransactions;
  }
  if (deterministic.length !== aiTransactions.length) {
    return deterministic.length > aiTransactions.length ? deterministic : aiTransactions;
  }
  return deterministic;
}

async function prepareBatch(context: VerticalContext, source: string): Promise<VerticalResult | null> {
  const [aiItems, deterministic] = await Promise.all([
    aiBatch(source),
    fallbackBatch(source)
  ]);
  const aiTransactions = (aiItems ?? [])
    .map(canonicalBatchItem)
    .filter((item): item is CashTransactionInput => Boolean(item));

  const transactions = selectCashBatchTransactions(aiTransactions, deterministic);
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