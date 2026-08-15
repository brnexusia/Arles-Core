import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { CashTransactionInput, CashTransactionType } from './types.js';

const ParsedTransactionSchema = z.object({
  is_transaction: z.boolean(),
  type: z.enum(['income', 'expense']),
  amount: z.number().positive().nullable(),
  category: z.string(),
  merchant: z.string(),
  description: z.string(),
  transaction_date: z.string()
});

const EXPENSE = /\b(gastei|paguei|comprei|despesa|saiu|debitei|custou|pague|gasto)\b/i;
const INCOME = /\b(recebi|ganhei|entrou|vendi|receita|faturei|depositaram|pix recebido)\b/i;

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function localDateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function amountFrom(text: string): number | null {
  const matches = [...text.matchAll(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi)];
  for (const match of matches) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 8), match.index ?? 0);
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 5);
    if (/\bdia\s*$/i.test(before) || /[\/-]\s*$/.test(before) || /^\s*[\/-]\s*\d/.test(after)) continue;
    const raw = match[1]!;
    const normalized = raw.includes(',')
      ? raw.replace(/\./g, '').replace(',', '.')
      : /^\d{1,3}(?:\.\d{3})+$/.test(raw)
        ? raw.replace(/\./g, '')
        : raw;
    const value = Number(normalized);
    if (Number.isFinite(value) && value > 0) return Math.round(value * 100) / 100;
  }
  return null;
}

function transactionType(text: string): CashTransactionType | null {
  if (EXPENSE.test(text)) return 'expense';
  if (INCOME.test(text)) return 'income';
  return null;
}

function dateFrom(text: string): string {
  if (/\bontem\b/i.test(text)) return localDateOffset(-1);
  if (/\banteontem\b/i.test(text)) return localDateOffset(-2);
  const explicit = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (!explicit) return isoToday();
  const yearRaw = explicit[3];
  const year = yearRaw ? Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : new Date().getUTCFullYear();
  const month = Number(explicit[2]);
  const day = Number(explicit[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? isoToday() : date.toISOString().slice(0, 10);
}

function categoryFrom(text: string, type: CashTransactionType): string {
  const value = text.toLowerCase();
  if (/mercado|supermercado|feira|alimento|comida/.test(value)) return 'Alimentação';
  if (/uber|99|gasolina|combustível|combustivel|ônibus|onibus|transporte/.test(value)) return 'Transporte';
  if (/aluguel|condomínio|condominio|luz|energia|água|agua|internet/.test(value)) return 'Moradia';
  if (/farmácia|farmacia|médico|medico|consulta|remédio|remedio/.test(value)) return 'Saúde';
  if (/curso|livro|escola|faculdade/.test(value)) return 'Educação';
  if (/salário|salario|pagamento|cliente|venda|serviço|servico/.test(value)) {
    return type === 'income' ? 'Vendas e serviços' : 'Trabalho';
  }
  return type === 'income' ? 'Outras receitas' : 'Outras despesas';
}

function merchantFrom(text: string): string {
  const withoutDate = text.replace(/\b(hoje|ontem|anteontem)\b/gi, '');
  const match = withoutDate.match(/\b(?:no|na|em|para o|para a)\s+([^,.]+?)(?:\s+(?:por|de)\s+r?\$?\s*\d|$)/i);
  return (match?.[1] ?? '').trim().slice(0, 120);
}

export function deterministicCashParse(text: string): CashTransactionInput | null {
  const type = transactionType(text);
  const amount = amountFrom(text);
  if (!type || !amount) return null;
  return {
    type,
    amount,
    category: categoryFrom(text, type),
    merchant: merchantFrom(text),
    description: text.trim().slice(0, 500),
    transactionDate: dateFrom(text)
  };
}

export class CashParser {
  private readonly client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

  async parse(text: string): Promise<CashTransactionInput | null> {
    const deterministic = deterministicCashParse(text);
    if (deterministic) return deterministic;
    if (!this.client) return null;

    try {
      const response = await this.client.responses.parse({
        model: env.openaiModel,
        input: [
          {
            role: 'system',
            content: [
              'Você extrai um único lançamento financeiro de mensagens em português do Brasil.',
              'expense é dinheiro que saiu; income é dinheiro que entrou.',
              'Não invente valor. Se não houver lançamento e valor claros, is_transaction=false.',
              'merchant é onde ocorreu ou quem pagou. category deve ser curta e útil.',
              `Hoje é ${isoToday()}. Converta hoje, ontem e datas relativas para YYYY-MM-DD.`,
              'description deve preservar uma observação útil enviada pelo usuário.'
            ].join('\n')
          },
          { role: 'user', content: text }
        ],
        text: { format: zodTextFormat(ParsedTransactionSchema, 'cash_transaction') }
      });
      const parsed = response.output_parsed;
      if (!parsed?.is_transaction || !parsed.amount) return null;
      return {
        type: parsed.type,
        amount: Math.round(parsed.amount * 100) / 100,
        category: parsed.category.trim() || categoryFrom(text, parsed.type),
        merchant: parsed.merchant.trim(),
        description: parsed.description.trim() || text.trim(),
        transactionDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.transaction_date)
          ? parsed.transaction_date
          : isoToday()
      };
    } catch (error) {
      console.error('[CashParser] falha na IA:', error);
      return null;
    }
  }
}

export const cashParser = new CashParser();
