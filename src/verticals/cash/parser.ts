import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { CashTransactionInput, CashTransactionType } from './types.js';
import { brazilParts, dateIsoOffset, isoBrazil } from './time.js';

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

const ParsedTransactionSchema = z.object({
  is_transaction: z.boolean(),
  type: z.enum(['income', 'expense']),
  amount: z.number().positive().nullable(),
  category: z.enum(CATEGORIES),
  merchant: z.string(),
  description: z.string(),
  transaction_date: z.string()
});

const EXPENSE = /\b(gastei|gasto|paguei|comprei|despesa|saiu|debitei|custou|pague|guardei|reservei|separei)\b/i;
const INCOME = /\b(recebi|recebimento|ganhei|entrou|vendi|receita|renda|faturei|depositaram|pix recebido|sal[aá]rio|freela|freelance)\b/i;

function amountFrom(text: string): number | null {
  const matches = [...text.matchAll(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi)];
  for (const match of matches) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 8), match.index ?? 0);
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 5);
    if (/\bdia\s*$/i.test(before) || /[\/-]\s*$/.test(before) || /^\s*[\/-]\s*\d/.test(after)) continue;
    const raw = match[1]!;
    const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(',', '.');
    const value = Number(normalized);
    if (Number.isFinite(value) && value > 0) return Math.round(value * 100) / 100;
  }
  return null;
}

function transactionType(text: string, amount: number | null): CashTransactionType | null {
  if (INCOME.test(text)) return 'income';
  if (EXPENSE.test(text)) return 'expense';
  if (!amount) return null;

  const usefulText = text.replace(/[\d.,R$\s]/gi, '');
  return usefulText.length >= 2 ? 'expense' : null;
}

function dateFrom(text: string): string {
  if (/\bontem\b/i.test(text)) return dateIsoOffset(-1);
  if (/\banteontem\b/i.test(text)) return dateIsoOffset(-2);
  if (/\bhoje\b/i.test(text)) return isoBrazil();

  const explicit = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (!explicit) return isoBrazil();

  const now = brazilParts();
  const yearRaw = explicit[3];
  const year = yearRaw ? Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : now.year;
  const month = Number(explicit[2]);
  const day = Number(explicit[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return isoBrazil();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function categoryFrom(text: string, type: CashTransactionType): string {
  if (type === 'income') return 'Receita';
  const value = text.toLowerCase();

  if (/\b(guardei|reservei|separei|poupança|poupanca|reserva)\b/.test(value)) return 'Reserva';
  if (/mercado|supermercado|feira|açougue|acougue|padaria|almoço|almoco|jantar|lanche|acaraj[eé]|ifood|delivery/.test(value)) return 'Alimentação';
  if (/uber|\b99\b|gasolina|combustível|combustivel|estacionamento|ônibus|onibus|metrô|metro|passagem|bicicleta/.test(value)) return 'Transporte';
  if (/farmácia|farmacia|médico|medico|consulta|exame|plano de saúde|plano de saude|remédio|remedio|xarope/.test(value)) return 'Saúde';
  if (/\bluz\b|\bágua\b|\bagua\b|internet|aluguel|condomínio|condominio|\bgás\b|\bgas\b/.test(value)) return 'Moradia';
  if (/escola|curso|livro|faculdade|mensalidade/.test(value)) return 'Educação';
  if (/salão|salao|unha|manicure|academia|roupa|blusa|blusinha|camisa|camiseta|calça|calca|vestido|short|bermuda|sapato|t[eê]nis|shopping|shein|acess[oó]rio|presente/.test(value)) return 'Pessoal';
  return 'Outros';
}

function merchantFrom(text: string): string {
  const withoutDate = text.replace(/\b(hoje|ontem|anteontem|agora)\b/gi, '');
  const match = withoutDate.match(/\b(?:no|na|em|para o|para a|de)\s+([^,.]+?)(?:\s+(?:por|de)\s+r?\$?\s*\d|$)/i);
  return (match?.[1] ?? '').trim().slice(0, 120);
}

export function descriptionFrom(text: string): string {
  let value = text.trim();
  value = value
    .replace(/\b(hoje|ontem|anteontem|agora)\b/gi, ' ')
    .replace(/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g, ' ')
    .replace(/^\s*(?:gastei|gasto|paguei|pague|comprei|despesa|saiu|debitei|custou|guardei|reservei|separei|recebi|recebimento|ganhei|entrou|vendi|receita|renda|faturei|depositaram)\s+/i, '')
    .replace(/(?:\b(?:por|de)\s+)?(?:r\$\s*)?\d{1,3}(?:\.\d{3})*(?:[.,]\d{1,2})?(?:\s*reais?)?/gi, ' ')
    .replace(/^\s*(?:um|uma)\s+/i, '')
    .replace(/^\s*(?:no|na|em|de)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(?:por|de|em)\s*$/i, '')
    .trim();

  return (value || text.trim()).slice(0, 500);
}

export function deterministicCashParse(text: string): CashTransactionInput | null {
  const amount = amountFrom(text);
  const type = transactionType(text, amount);
  if (!type || !amount) return null;
  return {
    type,
    amount,
    category: categoryFrom(text, type),
    merchant: merchantFrom(text),
    description: descriptionFrom(text),
    transactionDate: dateFrom(text)
  };
}

export class CashParser {
  private readonly client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

  async parse(text: string): Promise<CashTransactionInput | null> {
    // A IA é a interpretação principal. O parser determinístico é calculado em
    // paralelo como rede de segurança e só assume se a API não estiver disponível,
    // falhar ou recusar a mensagem por falta de dados suficientes.
    const deterministic = deterministicCashParse(text);
    if (!this.client) return deterministic;

    try {
      const response = await this.client.responses.parse({
        model: env.openaiModel,
        input: [
          {
            role: 'system',
            content: [
              'Você é o extrator principal de lançamentos do Arles Cash em português brasileiro.',
              'Entenda linguagem natural, erros de digitação, abreviações, gírias e frases curtas.',
              'Nunca invente valor, data, loja, pessoa ou descrição que não estejam sustentados pela mensagem.',
              'expense é dinheiro que saiu do disponível; income é dinheiro que entrou.',
              '“guardei”, “reservei” ou “separei dinheiro” é expense na categoria Reserva.',
              'Frases como “120 no almoço” ou “farmácia 45” são despesas.',
              'Se não houver lançamento e valor identificáveis, is_transaction=false.',
              'Use SOMENTE: Alimentação, Transporte, Saúde, Moradia, Educação, Pessoal, Reserva, Receita, Outros.',
              'Toda entrada usa Receita. Dinheiro guardado usa Reserva.',
              'merchant é loja, pessoa ou local somente quando estiver claro.',
              'description deve ser curta e humana, sem repetir verbo, valor e data.',
              `Hoje no fuso UTC-3 é ${isoBrazil()}. Converta datas relativas para YYYY-MM-DD.`
            ].join('\n')
          },
          { role: 'user', content: text }
        ],
        text: { format: zodTextFormat(ParsedTransactionSchema, 'cash_transaction') }
      });
      const parsed = response.output_parsed;
      if (!parsed?.is_transaction || !parsed.amount) return deterministic;

      return {
        type: parsed.type,
        amount: Math.round(parsed.amount * 100) / 100,
        category: parsed.type === 'income' ? 'Receita' : parsed.category,
        merchant: parsed.merchant.trim().slice(0, 120),
        description: parsed.description.trim().slice(0, 500) || deterministic?.description || descriptionFrom(text),
        transactionDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.transaction_date)
          ? parsed.transaction_date
          : deterministic?.transactionDate ?? isoBrazil()
      };
    } catch (error) {
      console.error('[CashParser] falha na IA; usando fallback determinístico:', error);
      return deterministic;
    }
  }
}

export const cashParser = new CashParser();
