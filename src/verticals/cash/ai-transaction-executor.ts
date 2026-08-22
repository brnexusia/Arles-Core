import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import {
  assignCashTransactionPocket,
  prepareCashPocketTransactions
} from './pocket-assignment.js';
import { clearCashFinancialIntentContext } from './intent-context.js';
import { rememberCashRecentRecordReference } from './conversation-state.js';
import { cashService } from './service.js';
import type { CashTransactionInput } from './types.js';
import { isoBrazil } from './time.js';

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

const TransactionItemSchema = z.object({
  type: z.enum(['income', 'expense']),
  amount: z.number().positive(),
  category: z.enum(CATEGORIES),
  merchant: z.string(),
  description: z.string(),
  transaction_date: z.string()
});

const TransactionBatchSchema = z.object({
  is_transaction: z.boolean(),
  items: z.array(TransactionItemSchema).max(25),
  clarification: z.string().nullable()
});

type TransactionBatch = z.infer<typeof TransactionBatchSchema>;

const client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

function text(value: string): VerticalResult {
  return { actions: [{ type: 'text', text: value }] };
}

function brl(value: number): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function canonicalItem(item: TransactionBatch['items'][number]): CashTransactionInput {
  return {
    type: item.type,
    amount: Math.round(item.amount * 100) / 100,
    category: item.type === 'income' ? 'Receita' : item.category,
    merchant: item.merchant.trim().slice(0, 120),
    description: item.description.trim().slice(0, 500),
    transactionDate: validIsoDate(item.transaction_date) ? item.transaction_date : isoBrazil()
  };
}

function estimatedNanoCostUsd(response: unknown): number {
  const usage = (response as any)?.usage;
  const input = Number(usage?.input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  // gpt-5-nano: US$0.05/M input e US$0.40/M output (preço padrão em 22/08/2026).
  return (input * 0.05 + output * 0.40) / 1_000_000;
}

function logUsage(
  context: VerticalContext,
  response: unknown,
  firstStageEstimatedUsd: number
): void {
  const usage = (response as any)?.usage;
  if (!usage) return;
  const secondStageCost = estimatedNanoCostUsd(response);
  const total = Math.max(0, firstStageEstimatedUsd) + secondStageCost;
  console.info(
    `[CashAI] stage=transaction_extract model=${env.cashOpenaiSecondModel}` +
    ` message=${context.message.messageId || 'unknown'}` +
    ` input_tokens=${usage.input_tokens ?? 0}` +
    ` output_tokens=${usage.output_tokens ?? 0}` +
    ` estimated_usd=${secondStageCost.toFixed(8)}` +
    ` estimated_total_usd=${total.toFixed(8)}`
  );
}

/**
 * Segunda camada do Cash.
 *
 * A IA NÃO grava nada. Ela transforma a intenção de lançamento já reconhecida pela
 * primeira IA em dados estruturados. Só depois disso o backend valida, aplica regras
 * de cofrinho/idempotência e persiste com cashService.createTransaction().
 */
export async function executeCashAiTransaction(
  context: VerticalContext,
  firstPassRewrite?: string | null,
  firstStageEstimatedUsd = 0
): Promise<VerticalResult | null> {
  if (!client) return null;

  const original = context.combinedText.trim();
  const normalized = firstPassRewrite?.trim() || original;

  try {
    const response = await client.responses.parse({
      model: env.cashOpenaiSecondModel,
      reasoning: { effort: 'minimal' },
      max_output_tokens: 600,
      input: [
        {
          role: 'system',
          content: [
            'Você é a SEGUNDA camada de compreensão do Arles Cash.',
            'A primeira camada já classificou a mensagem como possível lançamento financeiro.',
            'Sua única função é extrair dados de lançamentos REAIS e JÁ OCORRIDOS em JSON estruturado.',
            'Você NÃO grava no banco, NÃO calcula saldo, NÃO soma valores, NÃO responde perguntas e NÃO executa ações.',
            'Nunca transforme pergunta, simulação, previsão, recorrência, intenção futura ou conta a receber em lançamento real.',
            'Cada item precisa ter um valor monetário explícito ou inequívoco sustentado pelo texto. Nunca invente valor.',
            'Preserve centavos, sinal econômico, estabelecimento/pessoa, descrição e data informada.',
            `A data de hoje no contexto do produto é ${isoBrazil()}. Resolva “hoje”, “ontem” e dias da semana de forma coerente.`,
            'expense = dinheiro que realmente saiu; income = dinheiro que realmente entrou.',
            'Toda receita usa categoria Receita.',
            'Use somente as categorias: Alimentação, Transporte, Saúde, Moradia, Educação, Pessoal, Reserva, Receita, Outros.',
            'Se houver vários lançamentos reais, separe em vários itens, sem juntar ou calcular totais.',
            'Se não houver lançamento real completo, use is_transaction=false e items=[].',
            'clarification só deve ser preenchida quando o usuário claramente quer lançar algo mas falta um dado obrigatório, como o valor.',
            'Nunca peça confirmação depois que os dados estiverem completos.'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `Mensagem original: ${original}`,
            normalized !== original ? `Normalização da primeira IA: ${normalized}` : ''
          ].filter(Boolean).join('\n')
        }
      ],
      text: { format: zodTextFormat(TransactionBatchSchema, 'cash_transaction_batch') }
    });

    logUsage(context, response, firstStageEstimatedUsd);
    const parsed = response.output_parsed;
    if (!parsed?.is_transaction || !parsed.items.length) {
      const clarification = parsed?.clarification?.trim();
      return clarification ? text(clarification) : null;
    }

    const transactions = parsed.items.map(canonicalItem);
    const prepared = await prepareCashPocketTransactions(context.company.id, original, transactions);
    if (prepared.error) return text(prepared.error);

    await clearCashFinancialIntentContext(context.company.id, context.message.phone);

    const sourceMessageId = context.message.messageId || `cash:${Date.now()}`;
    const sourceMessage = original.slice(0, 5000);
    const saved = prepared.transactions.slice(0, 25);

    for (let index = 0; index < saved.length; index += 1) {
      const transaction = saved[index]!;
      const created = await cashService.createTransaction({
        companyId: context.company.id,
        phone: context.message.phone,
        sourceMessageId: saved.length === 1
          ? sourceMessageId
          : `${sourceMessageId}:item:${index + 1}`,
        sourceMessage,
        transaction
      });
      await assignCashTransactionPocket(context.company.id, String(created.id), transaction.pocketId);
    }

    await rememberCashRecentRecordReference(context.company.id, context.message.phone);

    if (saved.length === 1) {
      const item = saved[0]!;
      return text(`✅ Lançamento registrado: ${brl(item.amount)} em ${item.category}.`);
    }
    return text(`✅ ${saved.length} lançamentos registrados.`);
  } catch (error) {
    console.error('[CashAI] falha na segunda camada de lançamento:', error);
    return null;
  }
}
